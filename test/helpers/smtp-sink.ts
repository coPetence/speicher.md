import { AddressInfo, Server, Socket, createServer } from 'node:net';

export interface SmtpSink {
  port: number;
  messages: string[];
  verbs: string[];
  rejectLogin: boolean;
  close(): Promise<void>;
}

export async function startSmtpSink(): Promise<SmtpSink> {
  const state = { rejectLogin: false, verbs: [] as string[], messages: [] as string[] };
  const sockets = new Set<Socket>();

  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());

    let buffer = '';
    let body: string[] | null = null;
    socket.write('220 sink ESMTP\r\n');

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let cut = buffer.indexOf('\r\n');
      while (cut !== -1) {
        const line = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        cut = buffer.indexOf('\r\n');

        if (body !== null) {
          if (line === '.') {
            state.messages.push(body.join('\n'));
            body = null;
            socket.write('250 accepted\r\n');
          } else {
            body.push(line.startsWith('..') ? line.slice(1) : line);
          }
          continue;
        }

        const verb = line.split(' ')[0].toUpperCase();
        state.verbs.push(verb);

        if (verb === 'EHLO' || verb === 'HELO') {
          socket.write('250-sink\r\n250-SIZE 10485760\r\n250 AUTH PLAIN LOGIN\r\n');
        } else if (verb === 'AUTH') {
          socket.write(
            state.rejectLogin ? '535 5.7.8 authentication failed\r\n' : '235 2.7.0 accepted\r\n',
          );
        } else if (verb === 'DATA') {
          body = [];
          socket.write('354 go ahead\r\n');
        } else if (verb === 'QUIT') {
          socket.write('221 bye\r\n');
          socket.end();
        } else {
          socket.write('250 ok\r\n');
        }
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  return {
    port: (server.address() as AddressInfo).port,
    get messages() {
      return state.messages;
    },
    get verbs() {
      return state.verbs;
    },
    get rejectLogin() {
      return state.rejectLogin;
    },
    set rejectLogin(value: boolean) {
      state.rejectLogin = value;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
