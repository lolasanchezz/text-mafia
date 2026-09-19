import express from 'express';
import { createClient } from '@supabase/supabase-js';
import { loadEnvFile } from 'node:process';

loadEnvFile();

const app = express();
const port = 3000;

// The service role key bypasses Row Level Security, so this client can read
// and write every table. Server-side only — it must never reach a browser.
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_API_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

app.use(express.json());

app.get('/', (req, res) => {
  res.send('Hello World!');
});

app.get('/table/:name', async (req, res) => {
  const { data, error } = await supabase.from(req.params.name).select('*');
  if (error) res.status(400).json(error);
  else res.json(data);
});

app.post('/webhook', async (req, res) => {
  console.log('parts', req.body.data.parts)
  console.log('user-record', req.body.data.chat.owner_handle)


  const start_message = "i wanna play mafia"

  if ((req.body.data.parts[0].type == "text") && (req.body.data.parts[0].value.toLowerCase() == start_message)) {
    const {data, error} = await supabase.from("users").select('number, current_game').eq('number', req.body.data.chat.owner_handle)
    if (error) res.status(400).json(error);
    console.log(data)
  }



  res.sendStatus(200);
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
