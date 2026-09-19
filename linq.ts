import LinqAPIV3 from '@linqapp/sdk';
import { loadEnvFile } from 'node:process';
loadEnvFile()
const client = new LinqAPIV3({
  apiKey: process.env.LINQ_API_V3_API_KEY,
});

const PHONE_NUMBER = process.env.PHONE_NUMBER ?? ""
const LOLA_PHONE = process.env.LOLA_PHONE ?? ""
const ESTELLA_PHONE = process.env.ESTELLA_PHONE ?? ""

// Send a message
const chat = await client.chats.create({
  from: PHONE_NUMBER,
  to: [LOLA_PHONE, ESTELLA_PHONE],
  message: {
    parts: [{ type: 'text', value: 'Hello from Linq!' }],
  },
});