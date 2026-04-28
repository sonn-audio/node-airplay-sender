import net from 'node:net';

/**
 * Minimal HTTP/1.1 client for plain TCP connections (no TLS).
 * Used for AirPlay control endpoints where lightweight parsing is sufficient.
 */

// ...

type Headers = Record<string, string>;
export type MessageObject = {
  method?: string;
  path?: string;
  statusCode?: number;
  headers: Headers;
  body?: Buffer;
};

export interface HttpClientApi {
  connect(host: string, port?: number): Promise<void>;
  request(method: string, path: string, headers?: Headers, body?: Buffer): Promise<MessageObject | null>;
  close(): void;
}

const HttpMessage = (
  parseStartLine: (line: string, messageObject: MessageObject) => void,
  writeStartLine: (messageObject: MessageObject) => string,
) => {
    const instance: {
      parse: (buffer: Buffer) => MessageObject;
      write: (messageObject: MessageObject) => Buffer;
    } = {
      parse: () => ({ headers: {} }),
      write: () => Buffer.alloc(0),
    };

    instance.parse = (buffer: Buffer) => {
        const messageObject: MessageObject = { headers: {} };

        // ...

        let bodyIndex       = buffer.indexOf('\r\n\r\n');
        let headerString    = buffer.slice(0, bodyIndex).toString();
        let body            = buffer.slice(bodyIndex + 4);

        headerString = headerString.replace(/\r\n/g, '\n');

        const lines         = headerString.split('\n');

        bodyIndex += 2;

        // ...

        let line = lines.shift();
        if (line) {
          parseStartLine(line, messageObject);
        }

        // ...

        line = lines.shift();
        while (line)
        {
            const headerName    = line.substr(0, line.indexOf(':'));
            const headerValue   = line.substr(line.indexOf(':') + 1);

            messageObject.headers[headerName] = headerValue.trim();
            
            line = lines.shift();
        }  

        // ...

        if (messageObject.headers['Content-Length'] && messageObject.headers['Content-Length'] !== '0')
        {
            messageObject.body = body;
        }

        return messageObject;
    };

    instance.write = (messageObject: MessageObject) => {
        let messageString = writeStartLine(messageObject);
        messageString += '\r\n';

        if (messageObject.body)
        {
            messageObject.headers['Content-Length'] = String(Buffer.byteLength(messageObject.body));
        }

        for (const header in messageObject.headers)
        {
            messageString += `${header}: ${messageObject.headers[header]}\r\n`;
        }

        messageString += '\r\n';

        const buffer = Buffer.from(messageString);
        
        if (!messageObject.body)
        {
            return buffer;
        }

        return Buffer.concat([buffer, messageObject.body], buffer.length + messageObject.body.length);
    };

    return instance;
};

const HttpRequest = () =>
  HttpMessage(
    () => {}, // currently not parsing requests.
    (messageObject) => `${messageObject.method} ${messageObject.path} HTTP/1.1`,
  );

const HttpResponse = () =>
  HttpMessage(
    (line, messageObject) => {
      messageObject.statusCode = parseInt(line.split(' ')[1], 10);
    },
    () => '', // currently not writing responses.
  );

// ...

class HttpClient implements HttpClientApi {
    private resolveQueue: Array<{
      resolve: (res: MessageObject | null) => void;
      reject: (err: Error) => void;
    }> = [];
    private pendingResponse: { res: MessageObject; remaining: number } | null = null;
    private socket?: net.Socket;
    private host?: string;

    // ....

    parseResponse(data: Buffer)
    {
        const res = HttpResponse().parse(data);
        if (res.headers['Content-Length'] && Number(res.headers['Content-Length']) > 0)
        {
            const remaining = Number(res.headers['Content-Length']) - (res.body?.byteLength ?? 0);
            if (remaining > 0)
            {
                // not all data for this response's corresponding request was read. Create a pending response object
                // to use for further reads.
                this.pendingResponse = {
                    res, 
                    remaining
                };
            }
        }

        if (!this.pendingResponse)
        {
            const rr = this.resolveQueue.shift();
            if (!rr) return;
            res.statusCode === 200 
                ? rr.resolve(res)
                : rr.resolve(null);
        }
    }

    // ...

    connect(host: string, port = 80): Promise<void>
    {
        this.host = host;

        return new Promise(resolve => {
            this.socket = net.connect(
                {
                    host,
                    port
                },
                resolve
            );

            this.socket.on('data', data => {
                const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
                if (!this.pendingResponse)
                {
                    // there is no response pending, parse the data.
                    this.parseResponse(chunk);
                }
                else
                {
                    // incoming data for the pending response.
                    const existing = this.pendingResponse.res.body ?? Buffer.alloc(0);
                    this.pendingResponse.res.body = Buffer.concat(
                        [existing, chunk],
                        chunk.byteLength + existing.byteLength
                    );

                    this.pendingResponse.remaining -= chunk.byteLength;
                    if (this.pendingResponse.remaining === 0)
                    {
                        // all remaining data for the pending response has been read; resolve the promise for the 
                        // corresponding request.
                        const rr = this.resolveQueue.shift();
                        if (!rr) {
                            this.pendingResponse = null;
                            return;
                        }
                        this.pendingResponse.res.statusCode === 200 
                            ? rr.resolve(this.pendingResponse.res)
                            : rr.reject(new Error(`HTTP status: ${this.pendingResponse.res.statusCode}`));

                        this.pendingResponse = null;
                    }
                }
            });
        });
    }

    request(method: string, path: string, headers?: Headers, body?: Buffer): Promise<MessageObject | null>
    {
        headers = headers || {};
        // headers['Host'] = `${this.host}:${this.socket.remotePort}`;

        const data = HttpRequest().write({
            method,
            path,
            headers,
            body
        });

        // ...

        return new Promise((resolve, reject) => {
            this.resolveQueue.push({ resolve, reject });
            this.socket?.write(data);
        });
    }

    close(): void
    {
        this.socket?.end();
    }
}

// ...

const createHttpClient = (): HttpClientApi => new HttpClient();

export default createHttpClient;
