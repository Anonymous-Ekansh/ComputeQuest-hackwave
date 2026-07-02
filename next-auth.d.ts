import NextAuth, { DefaultSession, DefaultUser } from 'next-auth';
import { JWT } from 'next-auth/jwt';

declare module 'next-auth' {
  interface Session {
    user: {
      id: string;
      credits?: number;
    } & DefaultSession['user'];
  }

  interface User extends DefaultUser {
    credits?: number;
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    id?: string;
    credits?: number;
  }
}
