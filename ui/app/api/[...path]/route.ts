import { NextRequest } from "next/server";

// Resolved at request time (runtime), not build time — so Docker env vars work.
const API_URL = () => process.env.API_URL ?? "http://localhost:8001";

async function proxy(request: NextRequest, path: string[]) {
  const url = `${API_URL()}/api/${path.join("/")}`;

  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const res = await fetch(url, {
    method: request.method,
    headers: {
      "Content-Type": request.headers.get("Content-Type") ?? "application/json",
    },
    ...(hasBody ? { body: request.body, duplex: "half" } : {}),
  } as RequestInit);

  return new Response(res.body, {
    status: res.status,
    headers: {
      "Content-Type": res.headers.get("Content-Type") ?? "text/plain",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    },
  });
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  return proxy(request, (await params).path);
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  return proxy(request, (await params).path);
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  return proxy(request, (await params).path);
}
