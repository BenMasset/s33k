import { writeFile } from 'fs/promises';
import type { NextApiRequest, NextApiResponse } from 'next';
import verifyUser from '../../utils/verifyUser';

// Clears the global scraper retry queue. This is a legacy instance-level maintenance route, so it
// remains on verifyUser rather than authorize() until the retry queue is made tenant-aware. If the
// failed queue ever stores owner_id/domain ownership, revisit this route before exposing it to
// tenant API keys.

type SettingsGetResponse = {
   cleared?: boolean,
   error?: string,
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
   const authorized = verifyUser(req, res);
   if (authorized !== 'authorized') {
      return res.status(401).json({ error: authorized });
   }
   if (req.method === 'PUT') {
      return clearFailedQueue(req, res);
   }
   return res.status(405).json({ error: 'Method Not Allowed.' });
}

const clearFailedQueue = async (req: NextApiRequest, res: NextApiResponse<SettingsGetResponse>) => {
   try {
      await writeFile(`${process.cwd()}/data/failed_queue.json`, JSON.stringify([]), { encoding: 'utf-8' });
      return res.status(200).json({ cleared: true });
   } catch (error) {
      console.log('[ERROR] Clearing Failed Queue File.', error);
      // A13: the file write failed, so the queue was NOT cleared. That is a server-side
      // failure, not a success, and must not report 200.
      return res.status(500).json({ error: 'Error Clearing Failed Queue!' });
   }
};
