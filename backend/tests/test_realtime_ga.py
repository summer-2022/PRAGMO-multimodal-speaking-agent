"""Exercise actual Realtime handler code offline, without startup or credentials."""
import ast
import asyncio
import base64
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock

SOURCE = (Path(__file__).resolve().parents[1] / 'main.py').read_text()
TREE = ast.parse(SOURCE)
HANDLER = next(n for n in TREE.body if isinstance(n, ast.AsyncFunctionDef)
               and n.name == 'websocket_endpoint')


def function(name, **namespace):
    node = next(n for n in ast.walk(HANDLER)
                if isinstance(n, ast.AsyncFunctionDef) and n.name == name)
    ns = {'json': json, 'base64': base64, 'asyncio': asyncio,
          'PCM_CHUNK_BYTES': 4800, 'WebSocketDisconnect': EOFError,
          'print': lambda *args: None, **namespace}
    exec(compile(ast.Module(body=[node], type_ignores=[]), 'realtime-handler', 'exec'), ns)
    return ns[name]


class RealtimeSchemaTests(unittest.TestCase):
    def test_ga_model_and_headers(self):
        url = next(ast.literal_eval(n.value) for n in TREE.body
                   if isinstance(n, ast.Assign) and n.targets[0].id == 'OPENAI_REALTIME_URL')
        self.assertEqual(url, 'wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1')
        headers = next(n for n in ast.walk(HANDLER) if isinstance(n, ast.Assign)
                       and isinstance(n.targets[0], ast.Name) and n.targets[0].id == 'openai_headers')
        ns = {'OPENAI_API_KEY': 'offline-placeholder'}
        exec(compile(ast.Module(body=[headers], type_ignores=[]), 'headers', 'exec'), ns)
        self.assertEqual(ns['openai_headers'], {'Authorization': 'Bearer offline-placeholder'})

    def test_exact_ga_session_schema(self):
        payload = next(ast.literal_eval(n) for n in ast.walk(HANDLER)
                       if isinstance(n, ast.Dict) and any(isinstance(v, ast.Constant)
                       and v.value == 'session.update' for v in n.values))
        self.assertEqual(payload, {'type': 'session.update', 'session': {
            'type': 'realtime', 'output_modalities': ['audio'],
            'instructions': 'You are a U.S. university professor meeting a student during office hours. Begin with a neutral greeting without assuming why the student came. Respond naturally in one or two sentences. Ask no more than one question or make no more than one request per turn, and only when needed. If the student requests an assignment extension, focus on essential, typical considerations, accept sufficient answers, and conclude naturally without inventing requirements or probing minor details.',
            'audio': {
                'input': {'format': {'type': 'audio/pcm', 'rate': 24000},
                          'turn_detection': {'type': 'server_vad', 'threshold': 0.5,
                                             'prefix_padding_ms': 300, 'silence_duration_ms': 500},
                          'transcription': {'model': 'whisper-1'}},
                'output': {'format': {'type': 'audio/pcm', 'rate': 24000}, 'voice': 'verse'},
            }}})

    def test_ffmpeg_pcm_contract(self):
        call = next(n for n in ast.walk(HANDLER) if isinstance(n, ast.Call)
                    and isinstance(n.func, ast.Attribute) and n.func.attr == 'create_subprocess_exec')
        self.assertEqual([ast.literal_eval(a) for a in call.args],
                         ['ffmpeg', '-f', 'webm', '-i', 'pipe:0', '-f', 's16le',
                          '-ar', '24000', '-ac', '1', 'pipe:1'])


class RealtimeFlowTests(unittest.IsolatedAsyncioTestCase):
    async def test_ga_events_preserve_browser_contract_and_both_transcripts(self):
        for phase in ('sp1', 'sp2'):
            with self.subTest(phase=phase):
                events = [
                    {'type': 'input_audio_buffer.speech_started'},
                    {'type': 'input_audio_buffer.speech_stopped'},
                    {'type': 'conversation.item.input_audio_transcription.completed', 'transcript': ' Hello '},
                    {'type': 'response.output_audio_transcript.done', 'transcript': ' Welcome '},
                    {'type': 'response.output_audio.delta', 'delta': 'AAABAA=='},
                    {'type': 'response.output_audio.done'},
                ]
                async def upstream():
                    for event in events:
                        yield json.dumps(event)
                browser = SimpleNamespace(send_text=AsyncMock())
                session = {'phase': phase, 'sp1_transcript': [], 'sp2_transcript': []}
                await function('forward_openai_to_frontend', openai_ws=upstream(),
                               websocket=browser, session=session)()
                transcripts = [{'role': 'user', 'text': 'Hello'}, {'role': 'assistant', 'text': 'Welcome'}]
                self.assertEqual([json.loads(c.args[0]) for c in browser.send_text.call_args_list],
                                 [{'type': 'user_speaking'}, {'type': 'ai_speaking'}, *transcripts,
                                  {'type': 'audio.delta', 'audio': 'AAABAA=='}, {'type': 'audio.done'}])
                self.assertEqual(session[phase + '_transcript'], transcripts)
                self.assertEqual(session[('sp2' if phase == 'sp1' else 'sp1') + '_transcript'], [])

    async def test_microphone_pcm_is_forwarded_unchanged(self):
        pcm = bytes(range(256)) * 18
        process = SimpleNamespace(stdout=SimpleNamespace(read=AsyncMock(side_effect=[pcm, b''])))
        upstream = SimpleNamespace(send=AsyncMock())
        await function('pipe_ffmpeg_to_openai', ffmpeg_proc=process, openai_ws=upstream)()
        event = json.loads(upstream.send.call_args.args[0])
        self.assertEqual(event['type'], 'input_audio_buffer.append')
        self.assertEqual(base64.b64decode(event['audio']), pcm)
        self.assertEqual(process.stdout.read.call_args.args, (4800,))

    async def test_analysis_retry_evaluation_and_save_controls(self):
        sp1 = [{'role': 'user', 'text': 'First attempt'}]
        sp2 = [{'role': 'user', 'text': 'Second attempt'}]
        analysis = {'video_dialogue': [{'speaker': 'Professor', 'text': 'Exact.'}]}
        evaluation = {'score': 1}
        session = {'phase': 'sp1', 'sp1_transcript': sp1, 'sp2_transcript': [],
                   'scenario_key': 'professor_extension', 'scenario_label': 'Professor Extension Request'}
        controls = iter([{'bytes': b'microphone'}, {'text': json.dumps({'type': 'finish_sp1'})},
                         {'text': json.dumps({'type': 'start_sp2', 'sp1_transcript': sp1, 'analysis': analysis})},
                         {'text': json.dumps({'type': 'finish_sp2'})}])
        async def receive():
            try:
                message = next(controls)
            except StopIteration:
                raise EOFError from None
            if 'finish_sp2' in message.get('text', ''):
                self.assertEqual(session['phase'], 'sp2')
                self.assertEqual(session['sp2_transcript'], [])
                session['sp2_transcript'] = sp2
            return message
        browser = SimpleNamespace(receive=receive, send_text=AsyncMock())
        stdin = SimpleNamespace(write=Mock(), drain=AsyncMock(), close=Mock())
        analyze, evaluate, save = Mock(return_value=analysis), Mock(return_value=evaluation), Mock(return_value='offline-result')
        await function('pipe_frontend_to_ffmpeg', websocket=browser, session=session,
                       ffmpeg_proc=SimpleNamespace(stdin=stdin), analyze_transcript=analyze,
                       evaluate_session=evaluate, save_session_result=save)()
        analyze.assert_called_once_with(sp1)
        evaluate.assert_called_once_with('professor_extension', sp1, analysis, sp2)
        save.assert_called_once_with('professor_extension', 'Professor Extension Request', sp1,
                                     analysis, analysis['video_dialogue'], '', sp2, evaluation)
        self.assertEqual([json.loads(c.args[0]) for c in browser.send_text.call_args_list],
                         [{'type': 'analysis_result', 'data': analysis},
                          {'type': 'evaluation_result', 'data': evaluation}])
        stdin.write.assert_called_once_with(b'microphone')
        stdin.drain.assert_awaited_once()
        stdin.close.assert_called_once()


if __name__ == '__main__':
    unittest.main()
