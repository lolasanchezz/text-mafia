import express from 'express';
import { loadEnvFile } from 'node:process';

loadEnvFile();

const app = express();
const PORT = Number(process.env.PORT ?? 3000);

// Keep the raw body around — webhook signature checks need the exact bytes.
app.use(
  express.json({
    verify: (req, _res, buf) => {
      (req as any).rawBody = buf;
    },
  }),
);
app.use(express.urlencoded({ extended: true }));

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.post('/webhook', (req, res) => {
  console.log('--- webhook ---');
  console.log('headers:', req.headers);
  console.log('body:', JSON.stringify(req.body, null, 2));

  // Respond fast; do any slow work after the 200.
  res.sendStatus(200);
  
});

app.listen(PORT, () => {
  console.log(`listening on http://localhost:${PORT}/webhook`);
});
