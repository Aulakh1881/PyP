export async function POST() {
  return Response.json(
    { error: "PayPal Partner Referrals is not enabled for this sandbox app" },
    { status: 410 },
  );
}
