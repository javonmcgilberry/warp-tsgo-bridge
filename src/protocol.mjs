const HEADER_SEPARATOR = Buffer.from("\r\n\r\n");

export function encodeMessage(message) {
  const body = Buffer.from(JSON.stringify(message));
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}\r\n\r\n`),
    body,
  ]);
}

export function addWorkspaceRoot(message) {
  if (message?.method !== "initialize" || !message.params) {
    return { message, workspaceUri: undefined, changed: false };
  }

  const existingRoot = message.params.rootUri;
  const workspaceUri = existingRoot
    ?? message.params.workspaceFolders?.find((folder) => folder?.uri)?.uri;

  if (!workspaceUri || existingRoot) {
    return { message, workspaceUri, changed: false };
  }

  return {
    message: {
      ...message,
      params: {
        ...message.params,
        rootUri: workspaceUri,
      },
    },
    workspaceUri,
    changed: true,
  };
}

export class MessageDecoder {
  #buffer = Buffer.alloc(0);

  push(chunk) {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    const messages = [];

    while (true) {
      const separatorIndex = this.#buffer.indexOf(HEADER_SEPARATOR);
      if (separatorIndex < 0) break;

      const header = this.#buffer.subarray(0, separatorIndex).toString("ascii");
      const lengthMatch = /(?:^|\r\n)Content-Length:\s*(\d+)/i.exec(header);
      if (!lengthMatch) {
        throw new Error("LSP message is missing Content-Length.");
      }

      const bodyLength = Number(lengthMatch[1]);
      const bodyStart = separatorIndex + HEADER_SEPARATOR.length;
      const frameLength = bodyStart + bodyLength;
      if (this.#buffer.length < frameLength) break;

      const body = this.#buffer.subarray(bodyStart, frameLength);
      messages.push(JSON.parse(body.toString("utf8")));
      this.#buffer = this.#buffer.subarray(frameLength);
    }

    return messages;
  }
}
