import { NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
  try {
    const { endpoint, payload } = await request.json();

    const subdomain = process.env.SCORO_SUBDOMAIN;
    const apiKey = process.env.SCORO_API_KEY;
    const companyAccountId = process.env.SCORO_ACCOUNT_ID;

    if (!subdomain || !apiKey || !companyAccountId) {
      return NextResponse.json(
        {
          status: "ERROR",
          statusCode: 500,
          messages: {
            error: [
              "Scoro credentials are not configured. Set SCORO_SUBDOMAIN, SCORO_API_KEY, and SCORO_ACCOUNT_ID environment variables.",
            ],
          },
        },
        { status: 500 }
      );
    }

    if (!endpoint || typeof endpoint !== "string") {
      return NextResponse.json(
        {
          status: "ERROR",
          statusCode: 400,
          messages: { error: ["Missing or invalid endpoint parameter."] },
        },
        { status: 400 }
      );
    }

    const url = `https://${subdomain}.scoro.com/api/v2${endpoint}`;

    const body = {
      apiKey,
      company_account_id: companyAccountId,
      ...(payload || {}),
    };

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown error occurred";
    return NextResponse.json(
      {
        status: "ERROR",
        statusCode: 500,
        messages: { error: [`Proxy error: ${message}`] },
      },
      { status: 500 }
    );
  }
}
