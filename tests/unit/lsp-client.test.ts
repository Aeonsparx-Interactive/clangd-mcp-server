// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { LSPClient } from '../../src/lsp-client.js';
import { LSPError } from '../../src/utils/errors.js';
import {
  MockWritableStream,
  MockReadableStream,
  sendLSPMessage,
  parseLSPMessages,
} from '../helpers/mock-streams.js';

describe('LSPClient', () => {
  let stdin: MockWritableStream;
  let stdout: MockReadableStream;
  let client: LSPClient;

  beforeEach(() => {
    stdin = new MockWritableStream();
    stdout = new MockReadableStream();
    client = new LSPClient(stdin, stdout);
  });

  afterEach(() => {
    client.close();
    stdin.cleanup();
    stdout.cleanup();
  });

  describe('request', () => {
    it('should send properly formatted JSON-RPC request', async () => {
      const responsePromise = client.request('test/method', { param: 'value' });

      // Check the message was sent correctly
      const messages = parseLSPMessages(stdin.getWrittenData());
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        jsonrpc: '2.0',
        id: expect.any(Number),
        method: 'test/method',
        params: { param: 'value' },
      });

      // Send response
      sendLSPMessage(stdout, {
        jsonrpc: '2.0',
        id: messages[0].id,
        result: { success: true },
      });

      const result = await responsePromise;
      expect(result).toEqual({ success: true });
    });

    it('should handle response with no params', async () => {
      const responsePromise = client.request('test/method');

      const messages = parseLSPMessages(stdin.getWrittenData());
      expect(messages[0]).toMatchObject({
        jsonrpc: '2.0',
        method: 'test/method',
      });

      sendLSPMessage(stdout, {
        jsonrpc: '2.0',
        id: messages[0].id,
        result: null,
      });

      await expect(responsePromise).resolves.toBeNull();
    });

    it('should increment request IDs', async () => {
      const promise1 = client.request('method1');
      const promise2 = client.request('method2');

      const messages = parseLSPMessages(stdin.getWrittenData());
      expect(messages[0].id).toBe(1);
      expect(messages[1].id).toBe(2);

      // Send responses
      sendLSPMessage(stdout, { jsonrpc: '2.0', id: 1, result: 'result1' });
      sendLSPMessage(stdout, { jsonrpc: '2.0', id: 2, result: 'result2' });

      await expect(promise1).resolves.toBe('result1');
      await expect(promise2).resolves.toBe('result2');
    });

    it('should handle error responses', async () => {
      const responsePromise = client.request('test/method');

      const messages = parseLSPMessages(stdin.getWrittenData());

      sendLSPMessage(stdout, {
        jsonrpc: '2.0',
        id: messages[0].id,
        error: {
          code: -32601,
          message: 'Method not found',
          data: { extra: 'info' },
        },
      });

      await expect(responsePromise).rejects.toThrow(LSPError);
      await expect(responsePromise).rejects.toMatchObject({
        message: 'Method not found',
        code: -32601,
        data: { extra: 'info' },
      });
    });

    it('should timeout after specified duration', async () => {
      const responsePromise = client.request('test/method', {}, 100);

      await expect(responsePromise).rejects.toThrow('timed out');
    }, 1000);

    it('should handle concurrent requests correctly', async () => {
      const promise1 = client.request('method1');
      const promise2 = client.request('method2');
      const promise3 = client.request('method3');

      const messages = parseLSPMessages(stdin.getWrittenData());
      expect(messages).toHaveLength(3);

      // Respond in different order
      sendLSPMessage(stdout, { jsonrpc: '2.0', id: messages[2].id, result: 'result3' });
      sendLSPMessage(stdout, { jsonrpc: '2.0', id: messages[0].id, result: 'result1' });
      sendLSPMessage(stdout, { jsonrpc: '2.0', id: messages[1].id, result: 'result2' });

      expect(await promise1).toBe('result1');
      expect(await promise2).toBe('result2');
      expect(await promise3).toBe('result3');
    });

    it('should handle partial message buffers', async () => {
      const responsePromise = client.request('test/method');

      const messages = parseLSPMessages(stdin.getWrittenData());
      const response = { jsonrpc: '2.0', id: messages[0].id, result: 'success' };
      const content = JSON.stringify(response);
      const header = `Content-Length: ${Buffer.byteLength(content)}\r\n\r\n`;
      const fullMessage = header + content;

      // Send message in chunks
      stdout.pushData(fullMessage.substring(0, 10));
      await new Promise((resolve) => setTimeout(resolve, 10));
      stdout.pushData(fullMessage.substring(10, 30));
      await new Promise((resolve) => setTimeout(resolve, 10));
      stdout.pushData(fullMessage.substring(30));

      await expect(responsePromise).resolves.toBe('success');
    });
  });

  describe('notify', () => {
    it('should send notification without ID', () => {
      client.notify('test/notification', { param: 'value' });

      const messages = parseLSPMessages(stdin.getWrittenData());
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        jsonrpc: '2.0',
        method: 'test/notification',
        params: { param: 'value' },
      });
      expect(messages[0]).not.toHaveProperty('id');
    });

    it('should send notification with no params', () => {
      client.notify('test/notification');

      const messages = parseLSPMessages(stdin.getWrittenData());
      expect(messages[0]).toMatchObject({
        jsonrpc: '2.0',
        method: 'test/notification',
      });
    });
  });

  describe('onNotification', () => {
    it('should handle incoming notifications', async () => {
      const handler = jest.fn();
      client.onNotification('test/notification', handler);

      sendLSPMessage(stdout, {
        jsonrpc: '2.0',
        method: 'test/notification',
        params: { data: 'test' },
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(handler).toHaveBeenCalledWith({ data: 'test' });
    });

    it('should support multiple notification handlers', async () => {
      const handler1 = jest.fn();
      const handler2 = jest.fn();

      client.onNotification('notification1', handler1);
      client.onNotification('notification2', handler2);

      sendLSPMessage(stdout, {
        jsonrpc: '2.0',
        method: 'notification1',
        params: { data: 'test1' },
      });

      sendLSPMessage(stdout, {
        jsonrpc: '2.0',
        method: 'notification2',
        params: { data: 'test2' },
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(handler1).toHaveBeenCalledWith({ data: 'test1' });
      expect(handler2).toHaveBeenCalledWith({ data: 'test2' });
    });

    it('should not throw if notification has no handler', async () => {
      sendLSPMessage(stdout, {
        jsonrpc: '2.0',
        method: 'unhandled/notification',
        params: {},
      });

      await new Promise((resolve) => setTimeout(resolve, 50));
      // Should not throw
    });
  });

  describe('stream lifecycle', () => {
    it('should reject pending requests on stream end', async () => {
      const promise1 = client.request('method1');
      const promise2 = client.request('method2');

      stdout.endStream();

      await expect(promise1).rejects.toThrow('LSP connection closed');
      await expect(promise2).rejects.toThrow('LSP connection closed');
    });

    it('should handle malformed JSON gracefully', async () => {
      const responsePromise = client.request('test/method');

      // Send malformed message (Content-Length matches actual byte count)
      stdout.pushData('Content-Length: 14\r\n\r\n{invalid json}');

      // Send valid response after
      await new Promise((resolve) => setTimeout(resolve, 50));
      const messages = parseLSPMessages(stdin.getWrittenData());
      sendLSPMessage(stdout, {
        jsonrpc: '2.0',
        id: messages[0].id,
        result: 'success',
      });

      await expect(responsePromise).resolves.toBe('success');
    });

    it('should close stdin on close()', () => {
      const endSpy = jest.spyOn(stdin, 'end');
      client.close();
      expect(endSpy).toHaveBeenCalled();
    });
  });

  // Content-Length is a BYTE count. A response body containing multi-byte UTF-8
  // (clangd emits `→` in hover markdown, and non-ASCII in identifiers, comments and
  // diagnostic text) is longer in bytes than in UTF-16 code units, so a string-based
  // framing buffer can never satisfy `buffer.length >= headerEnd + contentLength`
  // for the last message in the buffer: the response is never parsed, the request
  // times out, and the next message that arrives is sliced out of alignment.
  describe('multi-byte UTF-8 framing', () => {
    const encodeLSP = (message: any): Buffer => {
      const content = JSON.stringify(message);
      const body = Buffer.from(content, 'utf-8');
      return Buffer.concat([
        Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'utf-8'),
        body,
      ]);
    };

    const sentRequestId = (): number => parseLSPMessages(stdin.getWrittenData())[0].id;

    it('resolves a response whose body contains multi-byte characters', async () => {
      const responsePromise = client.request('textDocument/hover');

      const id = sentRequestId();
      // `→` is 3 bytes in UTF-8, 1 code unit in JS.
      stdout.pushData(
        encodeLSP({
          jsonrpc: '2.0',
          id,
          result: {
            contents: { kind: 'markdown', value: '### instance-method `X`\n\n→ `EReturn`' },
          },
        }),
      );

      const result = await responsePromise;
      expect(result.contents.value).toContain('→');
    });

    it('resolves a multi-byte response split across chunks inside a multi-byte character', async () => {
      const responsePromise = client.request('textDocument/hover');
      const id = sentRequestId();

      const message = encodeLSP({
        jsonrpc: '2.0',
        id,
        result: { contents: { kind: 'markdown', value: 'arrow → end' } },
      });
      // Split inside the 3-byte arrow: first 2 of its 3 bytes, then the rest.
      const arrowByte = message.indexOf(Buffer.from('→', 'utf-8'));
      stdout.pushData(message.subarray(0, arrowByte + 2));
      await new Promise((resolve) => setTimeout(resolve, 20));
      stdout.pushData(message.subarray(arrowByte + 2));

      const result = await responsePromise;
      expect(result.contents.value).toBe('arrow → end');
    });

    it('delivers a notification that follows a multi-byte response without losing either', async () => {
      const onDiagnostics = jest.fn();
      client.onNotification('textDocument/publishDiagnostics', onDiagnostics);

      const responsePromise = client.request('textDocument/hover');
      const id = sentRequestId();

      stdout.pushData(
        encodeLSP({ jsonrpc: '2.0', id, result: { contents: { kind: 'markdown', value: 'a → b' } } }),
      );
      stdout.pushData(
        encodeLSP({
          jsonrpc: '2.0',
          method: 'textDocument/publishDiagnostics',
          params: { uri: 'file:///a.cpp', diagnostics: [{ message: 'note → here' }] },
        }),
      );

      const result = await responsePromise;
      expect(result.contents.value).toBe('a → b');
      expect(onDiagnostics).toHaveBeenCalledTimes(1);
      expect((onDiagnostics.mock.calls[0][0] as any).diagnostics[0].message).toBe('note → here');
    });
  });
});
