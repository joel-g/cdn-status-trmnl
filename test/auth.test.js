import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAuthorized } from '../src/auth.js';

const request = authorization =>
  new Request('https://worker.example/trigger', { method: 'POST', headers: authorization ? { Authorization: authorization } : {} });

test('accepts the configured bearer token', async () => {
  assert.equal(await isAuthorized(request('Bearer s3cret'), 's3cret'), true);
});

test('rejects wrong, missing or non-bearer credentials', async () => {
  assert.equal(await isAuthorized(request('Bearer nope'), 's3cret'), false);
  assert.equal(await isAuthorized(request(), 's3cret'), false);
  assert.equal(await isAuthorized(request('s3cret'), 's3cret'), false);
});

test('rejects everything when no token is configured', async () => {
  assert.equal(await isAuthorized(request('Bearer '), undefined), false);
  assert.equal(await isAuthorized(request('Bearer '), ''), false);
});
