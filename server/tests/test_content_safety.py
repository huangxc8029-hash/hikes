import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch, Mock
import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.content_safety import TextModerator, ModerationError


class ContentSafetyTests(unittest.TestCase):
    def run_check(self, payload):
        client = Mock()
        client.get.return_value.json.return_value = {'access_token': 'test-token', 'expires_in': 7200}
        client.post.return_value.json.return_value = payload
        with patch.dict(os.environ, {'WECHAT_APP_ID': 'test', 'WECHAT_APP_SECRET': 'test'}), \
                patch('app.content_safety.httpx.Client') as factory:
            factory.return_value.__enter__.return_value = client
            TextModerator().check('测试留言', 'test-openid')
        return client

    def test_explicit_pass(self):
        client = self.run_check({'errcode': 0, 'result': {'suggest': 'pass'}})
        self.assertEqual(client.post.call_args.kwargs['json']['scene'], 2)
        self.assertEqual(client.post.call_args.kwargs['json']['openid'], 'test-openid')

    def test_risky_and_review_block_publication(self):
        for suggestion in ('risky', 'review'):
            with self.subTest(suggestion=suggestion), self.assertRaises(ModerationError) as caught:
                self.run_check({'errcode': 0, 'result': {'suggest': suggestion}})
            self.assertEqual(caught.exception.code, 'CONTENT_REJECTED')

    def test_missing_verdict_and_provider_error_fail_closed(self):
        for payload in ({}, {'errcode': 40001}, {'result': {'suggest': 'unknown'}}, None):
            with self.subTest(payload=payload), self.assertRaises(ModerationError) as caught:
                self.run_check(payload)
            self.assertEqual(caught.exception.code, 'CONTENT_REVIEW_UNAVAILABLE')

    def test_credentials_required(self):
        with patch.dict(os.environ, {}, clear=True), self.assertRaises(ModerationError) as caught:
            TextModerator().check('text', 'id')
        self.assertEqual(caught.exception.code, 'CONTENT_REVIEW_NOT_CONFIGURED')

    def test_identity_required(self):
        with patch.dict(os.environ, {'WECHAT_APP_ID': 'test', 'WECHAT_APP_SECRET': 'test'}), \
                self.assertRaises(ModerationError) as caught:
            TextModerator().check('text', None)
        self.assertEqual(caught.exception.status, 403)

    def test_timeout_does_not_publish(self):
        with patch.dict(os.environ, {'WECHAT_APP_ID': 'test', 'WECHAT_APP_SECRET': 'test'}), \
                patch('app.content_safety.httpx.Client') as factory:
            factory.return_value.__enter__.return_value.get.side_effect = httpx.TimeoutException('timeout')
            with self.assertRaises(ModerationError) as caught:
                TextModerator().check('text', 'openid')
            self.assertEqual(caught.exception.code, 'CONTENT_REVIEW_UNAVAILABLE')


if __name__ == '__main__':
    unittest.main()
