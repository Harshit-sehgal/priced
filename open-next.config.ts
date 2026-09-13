import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// The beta deployment does not require a paid cache service. Dynamic market
// pages remain authoritative in Supabase; Cloudflare serves the adapted
// Next.js worker and static assets without provisioning R2 or another paid
// persistence layer.
export default defineCloudflareConfig();
