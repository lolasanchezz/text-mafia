// One-off script: creates (or finds) a group chat with whoever you list.
// Usage: node linq_library.ts +16177779754 +19788818678 [+more...]
import LinqAPIV3 from '@linqapp/sdk';
import { loadEnvFile } from 'node:process';

loadEnvFile();

const client = new LinqAPIV3({
  apiKey: process.env.LINQ_API_V3_API_KEY,
});

const to = process.argv.slice(2);
if (to.length === 0) {
  console.error('Usage: node linq_library.ts <phone1> <phone2> ...');
  process.exit(1);
}

const chat = await client.chats.create({
  from: process.env.LINQ_FROM ?? '',
  to,
  message: {
    parts: [{ type: 'text', value: 'Hello from Linq!' }],
  },
});

console.log(`Created/found chat ${chat.chat.id} with: ${to.join(', ')}`);
