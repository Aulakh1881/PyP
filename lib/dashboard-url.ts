// Where "Open dashboard" and the post-sign-in redirect go: the prototype
// dashboard. Defaults to the demo-data copy on :8080; set it to
// http://localhost:3001/app/?authenticated=1 for the live one (npm run live).
export const DASHBOARD_URL =
  process.env.NEXT_PUBLIC_PYP_DASHBOARD_URL || "http://localhost:8080/app/?authenticated=1";
