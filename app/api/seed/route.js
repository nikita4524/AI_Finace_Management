import arcjet, { shield, detectBot } from "@arcjet/next";
import { seedTransactions } from "@/actions/seed";

const aj = arcjet({
  key: process.env.ARCJET_KEY,
  rules: [
    shield({ mode: "LIVE" }),
    detectBot({ mode: "LIVE" }),
  ],
});

export async function GET(req) {
  
  const decision = await aj.protect(req);
  if (decision.isDenied()) {
    return new Response(JSON.stringify({ error: "Security check failed" }), { 
      status: 403,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  const result = await seedTransactions();
  return Response.json(result);
}s