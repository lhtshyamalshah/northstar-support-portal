import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface CapturedRequest {
  method: string | undefined;
  url: string | undefined;
  authorization: string | undefined;
  contentType: string | undefined;
  body: string;
}

export type JsonServerResponse = (requests: readonly CapturedRequest[]) => unknown;

/** Creates a successful governance microservice response envelope. */
export function governanceResponse<TResponse>(responseData: TResponse): {
  responseData: TResponse;
  message: string;
  success: true;
  responseCode: number;
} {
  return {
    responseData,
    message: "Information added successfully",
    success: true,
    responseCode: 200
  };
}

export async function withJsonServer(
  responseBody: JsonServerResponse,
  run: (baseUrl: string, requests: CapturedRequest[]) => Promise<void>
): Promise<void> {
  const requests: CapturedRequest[] = [];
  const server = createServer((request, response) => {
    void handleJsonRequest(request, response, requests, responseBody);
  });

  await listen(server);

  try {
    const address = server.address();

    if (address === null || typeof address === "string") {
      throw new Error("Expected server to listen on a TCP port");
    }

    await run(`http://127.0.0.1:${address.port}`, requests);
  } finally {
    await close(server);
  }
}

export function requireFirstRequest(requests: readonly CapturedRequest[]): CapturedRequest {
  const request = requests[0];

  if (request === undefined) {
    throw new Error("Expected one captured request");
  }

  return request;
}

async function handleJsonRequest(
  request: IncomingMessage,
  response: ServerResponse<IncomingMessage>,
  requests: CapturedRequest[],
  responseBody: JsonServerResponse
): Promise<void> {
  try {
    const body = await readRequestBody(request);

    requests.push({
      method: request.method,
      url: request.url,
      authorization: readHeader(request.headers.authorization),
      contentType: readHeader(request.headers["content-type"]),
      body
    });

    response.statusCode = 200;
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(responseBody(requests)));
  } catch (error) {
    response.statusCode = 500;
    response.end(error instanceof Error ? error.message : "Unexpected test server error");
  }
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address() as AddressInfo | null;

      if (address === null) {
        reject(new Error("Server did not return a listening address"));
        return;
      }

      resolve();
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error !== undefined) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const rawChunk of request) {
    const chunk: unknown = rawChunk;

    if (typeof chunk === "string") {
      chunks.push(Buffer.from(chunk));
    } else if (chunk instanceof Buffer) {
      chunks.push(chunk);
    } else if (chunk instanceof Uint8Array) {
      chunks.push(Buffer.from(chunk));
    } else {
      throw new TypeError("Unsupported request body chunk");
    }
  }

  return Buffer.concat(chunks).toString("utf-8");
}

function readHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value.join(", ") : value;
}
