import { io, Socket } from 'socket.io-client';
import { getAccessToken } from './api-client';

let socket: Socket | null = null;

// Single shared socket for the whole app — components join/leave rooms as
// needed rather than each opening their own connection.
export function getSocket(): Socket {
  if (!socket) {
    socket = io('/', {
      path: '/socket.io',
      auth: (cb) => cb({ token: getAccessToken() }),
      autoConnect: true,
    });
  }
  return socket;
}
