// SPDX-License-Identifier: AGPL-3.0-only

import crypto from 'crypto';
import http2 from 'http2';
import { GoogleAuth } from 'google-auth-library';

const FCM_SCOPES = ['https://www.googleapis.com/auth/firebase.messaging'];

export function createPushProviders({
  fcmProjectId,
  fcmCredentialsJson,
  apnsTeamId,
  apnsKeyId,
  apnsPrivateKey,
  apnsVoipTopic,
  apnsMessagesTopic,
  apnsUseSandbox,
  normalizeStringValue,
}) {
  let googleAuthClient = null;
  let apnsJwtCache = null;

  function getGoogleAuthClient() {
    if (googleAuthClient) return googleAuthClient;
    if (!fcmProjectId) {
      throw new Error('FCM_PROJECT_ID is not configured');
    }
    const credentials = parseFcmCredentialsJson();
    googleAuthClient = new GoogleAuth({
      credentials,
      scopes: FCM_SCOPES,
    });
    return googleAuthClient;
  }

  function parseFcmCredentialsJson() {
    if (!fcmCredentialsJson) {
      return undefined;
    }
    try {
      return JSON.parse(fcmCredentialsJson);
    } catch (error) {
      throw new Error(
        'FCM_CREDENTIALS_JSON is invalid JSON; wrap the service account JSON '
          + 'in single quotes in .env.push.local. '
          + (error instanceof Error ? error.message : String(error)),
      );
    }
  }

  async function sendFcm({ token, data, notification, android }) {
    const auth = getGoogleAuthClient();
    const accessToken = await auth.getAccessToken();
    if (!accessToken) {
      throw new Error('failed to obtain FCM access token');
    }

    const message = {
      token,
      data: normalizeFcmData(data),
    };
    if (
      notification &&
      typeof notification === 'object' &&
      (typeof notification.title === 'string' || typeof notification.body === 'string')
    ) {
      message.notification = {};
      if (typeof notification.title === 'string') message.notification.title = notification.title;
      if (typeof notification.body === 'string') message.notification.body = notification.body;
      message.apns = {
        payload: {
          aps: {
            badge: 1,
            sound: 'default',
            alert: {
              ...(typeof notification.title === 'string' ? { title: notification.title } : {}),
              ...(typeof notification.body === 'string' ? { body: notification.body } : {}),
            },
          },
        },
      };
    }
    if (android && typeof android === 'object') {
      message.android = android;
    }

    const response = await fetch(
      `https://fcm.googleapis.com/v1/projects/${fcmProjectId}/messages:send`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ message }),
      },
    );
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`fcm status=${response.status} body=${text.slice(0, 512)}`);
    }
    return { ok: true, provider: 'fcm', raw: text };
  }

  function normalizeFcmData(data) {
    if (!data || typeof data !== 'object') {
      return {};
    }
    const out = {};
    for (const [key, value] of Object.entries(data)) {
      if (value === undefined || value === null) {
        continue;
      }
      if (typeof value === 'string') {
        out[key] = value;
        continue;
      }
      out[key] = typeof value === 'object' ? JSON.stringify(value) : String(value);
    }
    return out;
  }

  function hasApnsCredentials() {
    return Boolean(apnsTeamId && apnsKeyId && apnsPrivateKey);
  }

  function isApnsVoipConfigured() {
    return hasApnsCredentials() && Boolean(normalizeApnsVoipTopic(apnsVoipTopic));
  }

  function normalizeApnsVoipTopic(value) {
    const topic = normalizeStringValue(value, 256);
    if (!topic) return null;
    if (!topic.endsWith('.voip')) {
      return null;
    }
    return topic;
  }

  function normalizeApnsAlertTopic(value) {
    const topic = normalizeStringValue(value, 256);
    if (!topic) return null;
    if (topic.endsWith('.voip')) {
      return null;
    }
    return topic;
  }

  function isApnsAlertConfigured() {
    return hasApnsCredentials() && Boolean(normalizeApnsAlertTopic(apnsMessagesTopic));
  }

  function getApnsJwt() {
    if (!hasApnsCredentials()) {
      throw new Error('apns credentials are not configured');
    }
    const nowSec = Math.floor(Date.now() / 1000);
    if (apnsJwtCache && apnsJwtCache.expiresAtSec > nowSec + 30) {
      return apnsJwtCache.token;
    }
    const header = Buffer.from(
      JSON.stringify({ alg: 'ES256', kid: apnsKeyId }),
      'utf8',
    ).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({ iss: apnsTeamId, iat: nowSec }),
      'utf8',
    ).toString('base64url');
    const signingInput = `${header}.${payload}`;
    const privateKeyPem = apnsPrivateKey.includes('\\n')
      ? apnsPrivateKey.replace(/\\n/g, '\n')
      : apnsPrivateKey;
    const signer = crypto.createSign('sha256');
    signer.update(signingInput);
    signer.end();
    const signature = signer.sign(privateKeyPem).toString('base64url');
    const token = `${signingInput}.${signature}`;
    apnsJwtCache = {
      token,
      expiresAtSec: nowSec + 50 * 60,
    };
    return token;
  }

  async function sendApnsVoip({ token, payload, topic }) {
    const jwt = getApnsJwt();
    const host = apnsUseSandbox ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com';
    const resolvedTopic = normalizeApnsVoipTopic(topic) || normalizeApnsVoipTopic(apnsVoipTopic);
    if (!resolvedTopic) {
      throw new Error('apns voip topic is not configured or invalid (must end with .voip)');
    }
    return sendApnsHttp2({
      host,
      jwt,
      token,
      payload,
      pushType: 'voip',
      topic: resolvedTopic,
    });
  }

  async function sendApnsAlert({ token, payload, topic }) {
    const jwt = getApnsJwt();
    const host = apnsUseSandbox ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com';
    const resolvedTopic = normalizeApnsAlertTopic(topic) || normalizeApnsAlertTopic(apnsMessagesTopic);
    if (!resolvedTopic) {
      throw new Error('apns alert topic is not configured or invalid');
    }
    return sendApnsHttp2({
      host,
      jwt,
      token,
      payload,
      pushType: 'alert',
      topic: resolvedTopic,
    });
  }

  async function sendApnsHttp2({ host, jwt, token, payload, pushType, topic }) {
    const body = JSON.stringify(payload);
    const response = await new Promise((resolve, reject) => {
      const client = http2.connect(host);
      client.on('error', reject);

      const req = client.request({
        ':method': 'POST',
        ':path': `/3/device/${token}`,
        authorization: `bearer ${jwt}`,
        'apns-push-type': pushType,
        'apns-priority': '10',
        'apns-topic': topic,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      });

      let raw = '';
      let status = 0;

      req.setEncoding('utf8');
      req.on('response', (headers) => {
        status = Number(headers[':status'] || 0);
      });
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        client.close();
        resolve({ status, raw });
      });
      req.on('error', (error) => {
        client.close();
        reject(error);
      });

      req.write(body);
      req.end();
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`apns status=${response.status} body=${(response.raw || '').slice(0, 512)}`);
    }
    return { ok: true, provider: 'apns', raw: response.raw || '' };
  }

  return {
    isApnsAlertConfigured,
    isApnsVoipConfigured,
    normalizeApnsAlertTopic,
    normalizeApnsVoipTopic,
    sendApnsAlert,
    sendApnsVoip,
    sendFcm,
  };
}
