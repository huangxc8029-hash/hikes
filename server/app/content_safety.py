"""WeChat text moderation. Only an explicit pass permits publication."""
import os
import threading
import time

import httpx


class ModerationError(Exception):
    def __init__(self, code, message, status=503):
        self.code, self.message, self.status = code, message, status
        super().__init__(message)


class TextModerator:
    def __init__(self):
        self._lock = threading.Lock()
        self._token = None
        self._expires = 0
        self._credentials = None

    def check(self, content, openid):
        appid = os.getenv('WECHAT_APP_ID', '').strip()
        secret = os.getenv('WECHAT_APP_SECRET', '').strip()
        if not appid or not secret:
            raise ModerationError('CONTENT_REVIEW_NOT_CONFIGURED', '内容审核尚未配置，请保留草稿，稍后发布')
        if not openid:
            raise ModerationError('WECHAT_IDENTITY_REQUIRED', '请使用微信登录后发布公开内容', 403)
        try:
            with httpx.Client(timeout=4, trust_env=False) as client:
                with self._lock:
                    credentials = (appid, secret)
                    if self._credentials != credentials or time.monotonic() >= self._expires:
                        response = client.get('https://api.weixin.qq.com/cgi-bin/token', params={
                            'grant_type': 'client_credential', 'appid': appid, 'secret': secret})
                        response.raise_for_status()
                        data = response.json()
                        token = data.get('access_token')
                        expires = int(data.get('expires_in', 0))
                        if data.get('errcode') or not token or expires <= 60:
                            raise ValueError('invalid token response')
                        self._token, self._credentials = token, credentials
                        self._expires = time.monotonic() + expires - 60
                    token = self._token
                response = client.post('https://api.weixin.qq.com/wxa/msg_sec_check',
                    params={'access_token': token}, json={
                        'version': 2, 'scene': 2, 'openid': openid, 'content': content})
                response.raise_for_status()
                result = response.json()
                if result.get('errcode') == 87014:
                    raise ModerationError('CONTENT_REJECTED', '内容未通过审核，请修改后重试；原文未公开', 422)
                if result.get('errcode') in (40001, 40014, 42001):
                    with self._lock:
                        if self._token == token:
                            self._expires = 0
                if result.get('errcode', 0) != 0:
                    raise ValueError('moderation service error')
                suggestion = result.get('result', {}).get('suggest')
                if suggestion in ('risky', 'review'):
                    raise ModerationError('CONTENT_REJECTED', '内容未通过审核，请修改后重试；原文未公开', 422)
                if suggestion != 'pass':
                    raise ValueError('missing moderation verdict')
        except (httpx.HTTPError, ValueError, TypeError, AttributeError):
            # Never expose tokens, provider responses or submitted content in errors.
            raise ModerationError('CONTENT_REVIEW_UNAVAILABLE', '内容审核暂不可用，请保留草稿后重试') from None


moderator = TextModerator()
