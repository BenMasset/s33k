import type { NextApiRequest, NextApiResponse } from 'next';
import jwt from 'jsonwebtoken';
import Cookies from 'cookies';

type loginResponse = {
   success?: boolean
   error?: string|null,
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
   if (req.method === 'POST') {
      return loginUser(req, res);
   }
   return res.status(401).json({ success: false, error: 'Invalid Method' });
}

// Known SerpBear/s33k demo + placeholder values that must never run a public instance.
const DEMO_SECRETS = [
   '4715aed3216f7b0a38e6b534a958362654e96d10fbc04700770d572af3dce43625dd',
];
const DEMO_APIKEYS = [
   '5saedXklbslhnapihe2pihp3pih4fdnakhjwq5',
];
const DEMO_PASSWORDS = [
   '0123456789',
   'change-me-please',
];
const isPlaceholder = (value?: string): boolean => !!value && value.startsWith('REGENERATE_ME');

const loginUser = async (req: NextApiRequest, res: NextApiResponse<loginResponse>) => {
   if (!req.body.username || !req.body.password) {
      return res.status(401).json({ error: 'Username Password Missing' });
   }

   // Production safety: refuse to authenticate when the instance is still
   // configured with the public demo / placeholder credentials. Defends against
   // running `node server.js` directly (bypassing entrypoint.sh). Dev is unchanged.
   if (process.env.NODE_ENV === 'production') {
      const usingDemoCreds = DEMO_SECRETS.includes(process.env.SECRET || '')
         || isPlaceholder(process.env.SECRET)
         || DEMO_APIKEYS.includes(process.env.APIKEY || '')
         || isPlaceholder(process.env.APIKEY)
         || DEMO_PASSWORDS.includes(process.env.PASSWORD || '')
         || isPlaceholder(process.env.PASSWORD);
      if (usingDemoCreds) {
         console.error('[SECURITY] Login blocked: instance is using demo/placeholder credentials.'
            + ' Set strong SECRET, APIKEY, and PASSWORD (see DEPLOY.md).');
         return res.status(403).json({ error: 'Server is misconfigured with demo credentials. Set strong SECRET, APIKEY, and PASSWORD.' });
      }
   }

   const userName = process.env.USER_NAME ? process.env.USER_NAME : process.env.USER;

   if (req.body.username === userName
      && req.body.password === process.env.PASSWORD && process.env.SECRET) {
      const token = jwt.sign({ user: userName }, process.env.SECRET);
      const cookies = new Cookies(req, res);
      const expireDate = new Date();
      const sessDuration = process.env.SESSION_DURATION;
      expireDate.setHours((sessDuration && parseInt(sessDuration, 10)) || 24);
      cookies.set('token', token, { httpOnly: true, sameSite: 'lax', maxAge: expireDate.getTime() });
      return res.status(200).json({ success: true, error: null });
   }

   const error = req.body.username !== userName ? 'Incorrect Username' : 'Incorrect Password';

   return res.status(401).json({ success: false, error });
};
