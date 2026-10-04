const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async request => {
  if (request.method === "OPTIONS")
    return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return reply({ error: "Method not allowed" }, 405);

  const expectedPassword = Deno.env.get("TRACKER_WRITE_PASSWORD");
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!expectedPassword || !url || !serviceKey)
    return reply({ error: "Server is not configured" }, 500);

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return reply({ error: "Invalid JSON body" }, 400);
  }
  if (typeof body.password !== "string" || body.password !== expectedPassword)
    return reply({ error: "Wrong password" }, 401);

  let rpc: string;
  let args: Record<string, unknown>;
  if (body.action === "initialize") {
    if (!body.data || typeof body.data !== "object" || Array.isArray(body.data))
      return reply({ error: "Invalid initial tracker data" }, 400);
    rpc = "initialize_tracker_state";
    args = { p_data: body.data };
  } else if (body.action === "patch") {
    const patches = body.patches;
    if (!Array.isArray(patches) || patches.length === 0 || patches.length > 1000
        || patches.some(p => !p || !Array.isArray(p.path) || p.path.length === 0
          || p.path.length > 32 || !p.path.every(
            (part: unknown) => typeof part === "string" && part.length <= 100)
          || !Object.hasOwn(p, "value")))
      return reply({ error: "Invalid tracker changes" }, 400);
    rpc = "apply_tracker_patches";
    args = { p_patches: patches };
  } else {
    return reply({ error: "Unsupported action" }, 400);
  }

  const response = await fetch(`${url}/rest/v1/rpc/${rpc}`, {
    method: "POST",
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
  });
  if (!response.ok)
    return reply({ error: "Could not save shared tracker changes" }, 500);
  return reply({ data: await response.json() });
});
