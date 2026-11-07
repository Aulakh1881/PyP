// Where /dashboard sends people signed in on :3000: the live dashboard on :3001
// (npm run live). Set NEXT_PUBLIC_PYP_DASHBOARD_URL to use another address, e.g.
// http://localhost:8080/app/?authenticated=1 for the demo-data copy. Sign-in through
// :3001 always lands on :3001/app/, whatever this says.
export const DASHBOARD_URL =
  process.env.NEXT_PUBLIC_PYP_DASHBOARD_URL || "http://localhost:3001/app/?authenticated=1";
