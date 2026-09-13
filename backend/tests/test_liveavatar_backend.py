"""Offline tests; no dotenv, real credentials, main-module startup or network.
Run: python -B -m unittest discover -s backend/tests -v
"""
import ast
import base64
import json
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
from typing import Literal

from pydantic import BaseModel, StrictStr, ValidationError

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))
from config import liveavatar_feedback as config
from services import liveavatar_service as liveavatar
from services import tts_service as tts


class HTTPException(Exception):
    def __init__(self, status_code, detail):
        self.status_code, self.detail = status_code, detail


def routes(token_service, speech_service):
    # FastAPI is not installed in this local interpreter. Execute the actual
    # new route bodies and real Pydantic schema without importing main.py,
    # which initializes unrelated credential-dependent Realtime services.
    registered = {}
    def post(path):
        def register(fn):
            registered[path] = fn
            return fn
        return register
    tree = ast.parse((BACKEND / 'main.py').read_text())
    wanted = {'TTSRequest', 'dialogue_tokens_endpoint', 'tts_endpoint'}
    nodes = [node for node in tree.body if isinstance(node, (ast.ClassDef, ast.FunctionDef))
             and node.name in wanted]
    ns = {'app': SimpleNamespace(post=post), 'Response': object,
          'BaseModel': BaseModel, 'StrictStr': StrictStr, 'Literal': Literal,
          'HTTPException': HTTPException, 'base64': base64,
          'create_dialogue_tokens': token_service, 'synthesize_speech': speech_service}
    exec(compile(ast.Module(body=nodes, type_ignores=[]), 'new-routes', 'exec'), ns)
    return ns, registered


class LiveAvatarTests(unittest.TestCase):
    def test_exact_sandbox_pair(self):
        responses = [SimpleNamespace(ok=True, json=lambda: {'data': {'session_token': 'professor-token'}}),
                     SimpleNamespace(ok=True, json=lambda: {'data': {'session_token': 'student-token'}})]
        with patch.object(liveavatar.os, 'getenv', return_value='offline-placeholder'), \
             patch.object(liveavatar.requests, 'post', side_effect=responses) as post:
            self.assertEqual(liveavatar.create_dialogue_tokens(),
                             {'Professor': 'professor-token', 'Student': 'student-token'})
            self.assertEqual([call.kwargs['json'] for call in post.call_args_list], [
                {'mode': 'LITE', 'avatar_id': 'dd73ea75-1218-4ef3-92ce-606d5f7fbc0a', 'is_sandbox': True},
                {'mode': 'LITE', 'avatar_id': '65f9e3c9-d48b-4118-b73a-4ae2e3cbb8f0', 'is_sandbox': True},
            ])
            for call in post.call_args_list:
                self.assertEqual(call.args[0], 'https://api.liveavatar.com/v1/sessions/token')
                self.assertEqual(call.kwargs['timeout'], 30)

    def test_failure_never_returns_a_partial_pair(self):
        with patch.object(liveavatar, 'issue_session_token', side_effect=['first', RuntimeError('failure')]):
            with self.assertRaises(RuntimeError):
                liveavatar.create_dialogue_tokens()

    def test_bad_mapping_is_rejected_before_requests(self):
        for value in [None, '', config.ROLE_AVATARS['Professor']]:
            with patch.dict(liveavatar.ROLE_AVATARS, {'Student': value}), \
                 patch.object(liveavatar, 'issue_session_token') as issue:
                with self.assertRaises(RuntimeError):
                    liveavatar.create_dialogue_tokens()
                issue.assert_not_called()

    def test_provider_failures_are_sanitized(self):
        cases = [RuntimeError('private upstream body'), SimpleNamespace(ok=False),
                 SimpleNamespace(ok=True, json=lambda: {}),
                 SimpleNamespace(ok=True, json=lambda: {'data': {'session_token': ''}})]
        for response in cases:
            with patch.object(liveavatar.os, 'getenv', return_value='offline-placeholder'), \
                 patch.object(liveavatar.requests, 'post') as post:
                if isinstance(response, Exception): post.side_effect = response
                else: post.return_value = response
                with self.assertRaisesRegex(RuntimeError, '^LiveAvatar token request failed$'):
                    liveavatar.issue_session_token('offline-avatar')


class TTSTests(unittest.TestCase):
    def test_settings_match_working_test_verbatim(self):
        working = json.loads((BACKEND.parent / 'liveavatar_test/frontend/src/speechConfig.json').read_text())
        self.assertEqual(config.TTS_MODEL, working['model'])
        self.assertEqual(config.VERBATIM_INSTRUCTIONS, working['verbatimInstructions'])
        self.assertEqual(config.ROLE_DELIVERY, working['roles'])

    def client(self, content=b'\x00\x01', error=None):
        create = Mock(return_value=SimpleNamespace(content=content), side_effect=error)
        client = Mock()
        client.__enter__ = Mock(return_value=SimpleNamespace(audio=SimpleNamespace(speech=SimpleNamespace(create=create))))
        client.__exit__ = Mock(return_value=False)
        factory = Mock(return_value=client)
        return SimpleNamespace(OpenAI=factory), create

    def test_exact_text_voice_instructions_and_pcm(self):
        for role, voice in [('Professor', 'onyx'), ('Student', 'nova')]:
            module, create = self.client()
            with patch.dict(sys.modules, {'openai': module}), \
                 patch.object(tts.os, 'getenv', return_value='offline-placeholder'):
                text = '  Jiwon—please, consider Friday?\nThank you!  '
                self.assertEqual(tts.synthesize_speech(text, role), b'\x00\x01')
                self.assertEqual(create.call_args.kwargs, {
                    'model': 'gpt-4o-mini-tts', 'voice': voice,
                    'instructions': config.VERBATIM_INSTRUCTIONS + ' ' + config.ROLE_DELIVERY[role]['instructions'],
                    'input': text, 'response_format': 'pcm',
                })

    def test_invalid_input_precedes_credentials_and_provider(self):
        with patch.object(tts.os, 'getenv') as getenv:
            for text, role in [(' ', 'Student'), ('', 'Professor'), ('text', 'Other')]:
                with self.assertRaises(ValueError): tts.synthesize_speech(text, role)
            getenv.assert_not_called()

    def test_bad_pcm_and_provider_errors_are_sanitized(self):
        for content, error in [(b'', None), (b'x', None), ('not bytes', None),
                               (b'xx', RuntimeError('private upstream body'))]:
            module, _ = self.client(content, error)
            with patch.dict(sys.modules, {'openai': module}), \
                 patch.object(tts.os, 'getenv', return_value='offline-placeholder'):
                with self.assertRaisesRegex(RuntimeError, '^TTS generation failed$'):
                    tts.synthesize_speech('Exact text.', 'Professor')


class ContractTests(unittest.TestCase):
    def test_route_shapes_and_forwarding(self):
        tokens = Mock(return_value={'Professor': 'p', 'Student': 's'})
        speech = Mock(return_value=b'\x00\x01')
        ns, endpoints = routes(tokens, speech)
        self.assertEqual(set(endpoints), {'/tts', '/liveavatar/dialogue-tokens'})
        response = SimpleNamespace(headers={})
        self.assertEqual(endpoints['/liveavatar/dialogue-tokens'](response),
                         {'tokens': {'Professor': 'p', 'Student': 's'}})
        self.assertEqual(response.headers['Cache-Control'], 'no-store')
        request = ns['TTSRequest'](speaker='Student', text='  Exact text!\n')
        self.assertEqual(endpoints['/tts'](request), {'audio': 'AAE='})
        speech.assert_called_once_with('  Exact text!\n', 'Student')

    def test_schema_and_empty_text_rejection(self):
        speech = Mock()
        ns, endpoints = routes(Mock(), speech)
        for payload in [{'speaker': 'Other', 'text': 'text'}, {'text': 'text'},
                        {'speaker': 'Student', 'text': 123}, {'speaker': 'Student', 'text': None}]:
            with self.assertRaises(ValidationError): ns['TTSRequest'](**payload)
        for text in ['', ' \n\t']:
            with self.assertRaises(HTTPException) as caught:
                endpoints['/tts'](ns['TTSRequest'](speaker='Professor', text=text))
            self.assertEqual(caught.exception.status_code, 422)
        speech.assert_not_called()

    def test_routes_do_not_expose_service_errors(self):
        ns, endpoints = routes(Mock(side_effect=RuntimeError('private token body')),
                               Mock(side_effect=RuntimeError('private speech body')))
        for endpoint, request, expected in [
            ('/liveavatar/dialogue-tokens', SimpleNamespace(headers={}), 'LiveAvatar token request failed'),
            ('/tts', ns['TTSRequest'](speaker='Professor', text='Exact'), 'TTS generation failed'),
        ]:
            with self.assertRaises(HTTPException) as caught:
                endpoints[endpoint](request)
            self.assertEqual(caught.exception.status_code, 502)
            self.assertEqual(caught.exception.detail, expected)

    def test_missing_credentials_do_not_call_providers(self):
        with patch.object(liveavatar.os, 'getenv', return_value=None), \
             patch.object(liveavatar.requests, 'post') as post:
            with self.assertRaises(RuntimeError): liveavatar.create_dialogue_tokens()
            with self.assertRaises(RuntimeError): tts.synthesize_speech('Exact', 'Professor')
            post.assert_not_called()


if __name__ == '__main__':
    unittest.main()
