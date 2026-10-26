import { connection } from "next/server";

// Liveness check for Render's health check path. Answers at request time,
// never prerendered, and reveals nothing about configuration.
export async function GET() {
  await connection();
  return Response.json({ ok: true, service: "pyp", time: new Date().toISOString() });
}
