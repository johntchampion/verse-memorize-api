import 'dotenv/config';
import { createApp } from './app';
import { migrate } from './db/client';
import { jwtSecret } from './middleware/auth';

const PORT = Number(process.env.PORT ?? 3000);

// Fail at boot rather than on the first signup.
jwtSecret();
migrate();

createApp().listen(PORT, () => {
  console.log(`verse-memorize-api listening on :${PORT}`);
});
