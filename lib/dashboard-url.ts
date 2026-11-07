// Where /dashboard sends people signed in on :3000: the prototype dashboard.
// Defaults to the demo-data copy on :8080. Sign-in through :3001 (npm run live)
// always lands on :3001/app/, whatever this says.
export const DASHBOARD_URL =
  process.env.NEXT_PUBLIC_PYP_DASHBOARD_URL || "http://localhost:8080/app/?authenticated=1";
