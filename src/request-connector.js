export function getRequestFetcher(request) {
  try {
    const fetcher = request?.fetcher;
    return fetcher && typeof fetcher.connect === 'function' ? fetcher : null;
  } catch {
    return null;
  }
}

export function hasRequestFetcher(request) {
  return Boolean(getRequestFetcher(request));
}

export function createRequestConnector(request, globalConnect) {
  const requestFetcher = getRequestFetcher(request);

  return async function requestAwareConnect(address, options) {
    const errors = [];

    if (requestFetcher) {
      let socket;
      try {
        socket = options === undefined
          ? requestFetcher.connect(address)
          : requestFetcher.connect(address, options);
        socket = await socket;
        if (!socket) throw new Error('request fetcher returned no socket');
        if (socket.opened) await socket.opened;
        return socket;
      } catch (error) {
        closeQuietly(socket);
        errors.push(`request-fetcher: ${error?.message || error}`);
      }
    }

    if (typeof globalConnect !== 'function') {
      throw new Error(errors.length ? errors.join(' | ') : 'global connector unavailable');
    }

    let socket;
    try {
      socket = options === undefined
        ? globalConnect(address)
        : globalConnect(address, options);
      socket = await socket;
      if (!socket) throw new Error('global connector returned no socket');
      if (socket.opened) await socket.opened;
      return socket;
    } catch (error) {
      closeQuietly(socket);
      errors.push(`global-connect: ${error?.message || error}`);
      throw new Error(errors.join(' | '));
    }
  };
}

function closeQuietly(socket) {
  try { socket?.close?.(); } catch {}
}
