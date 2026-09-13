import type { Metadata } from "next";
import Link from "next/link";
import { getProfileByHandle } from "@/lib/repo";
import { isHandleValid } from "@/lib/domains.ts";
import { getHolderAnalytics } from "@/lib/holder-analytics";
import { safeDecodeURIComponent } from "@/lib/navigation";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ handle: string }> };

export const metadata: Metadata = {
  title: "Holder analytics",
  robots: { index: false, follow: false },
};

export default async function HolderAnalyticsPage({ params }: Params) {
  const { handle } = await params;
  const h = safeDecodeURIComponent(handle).toLowerCase().replace(/^@/, "");
  if (!isHandleValid(h)) {
    return (
      <div className="stack">
        <h1 className="display display-section">That handle doesn&apos;t exist here.</h1>
        <Link href="/" className="btn">Back to the market</Link>
      </div>
    );
  }

  // Owner-only: the viewer must be this profile.
  let isOwn = false;
  try {
    const { getViewer, isAuthConfigured, demoViewer } = await import("@/lib/auth");
    const profile = await getProfileByHandle(h);
    if (profile) {
      const { user } = await getViewer();
      if (user) isOwn = user.id === profile.id;
      else if (!isAuthConfigured) isOwn = demoViewer().user.id === profile.id;
    }
  } catch {
    // auth not configured — demo path above already decided
  }
  if (!isOwn) {
    return (
      <div className="stack">
        <h1 className="display display-section">Not your analytics.</h1>
        <p className="muted">These numbers belong to @{h}.</p>
        <Link href={`/u/${h}`} className="btn">View @{h}&apos;s public profile</Link>
      </div>
    );
  }

  const [profile, analytics] = await Promise.all([
    getProfileByHandle(h),
    getHolderAnalytics(h),
  ]);
  if (!profile) {
    return (
      <div className="stack">
        <h1 className="display display-section">No profile yet.</h1>
        <Link href="/welcome" className="btn">Pick your handle</Link>
      </div>
    );
  }

  const hasAny =
    analytics.tagViews > 0 ||
    analytics.profileViews > 0 ||
    analytics.shareVisits > 0 ||
    analytics.ctaClicks > 0;

  return (
    <div className="stack-lg">
      <section className="stack">
        <p className="eyebrow">Holder analytics · last {analytics.windowDays} days</p>
        <h1 className="display display-section">Your tags, measured.</h1>
        <p className="muted" style={{ margin: 0 }}>
          Real counts from Priced traffic. Nothing estimated, nothing projected.
        </p>
      </section>

      {!analytics.available ? (
        <section className="notice">
          <strong>No datastore configured.</strong> Analytics need the production database.
          Local demo traffic is not persisted, so there is nothing honest to show here yet.
        </section>
      ) : !hasAny ? (
        <section className="notice">
          <strong>No traffic yet.</strong> Nobody has viewed your tags or profile in the last
          {" "}{analytics.windowDays} days. Share a takeover and this page fills in.
        </section>
      ) : (
        <>
          <section className="section-rule stack">
            <dl className="stat-list">
              <div className="stat-row">
                <dt>Tag views</dt>
                <dd className="money">{analytics.tagViews.toLocaleString()}</dd>
              </div>
              {/* "Unique visitors (sessions)" is deliberately NOT shown: server
                  -rendered tag_viewed rows carry no session id (the client
                  sessionStorage id is only attached to client beacons), so the
                  RPC's distinct-session count is structurally 0. Do not restore
                  the row without a session source for view events. */}
              <div className="stat-row">
                <dt>Profile views</dt>
                <dd className="money">{analytics.profileViews.toLocaleString()}</dd>
              </div>
              <div className="stat-row">
                <dt>Visits from your shared links</dt>
                <dd className="money">{analytics.shareVisits.toLocaleString()}</dd>
              </div>
              <div className="stat-row">
                <dt>CTA clicks</dt>
                <dd className="money">{analytics.ctaClicks.toLocaleString()}</dd>
              </div>
            </dl>
          </section>

          {analytics.byDomain.length > 0 ? (
            <section className="section-rule stack">
              <h2 className="display display-section">Traffic by tag (top 10)</h2>
              <ul className="holding-list">
                {analytics.byDomain.map((d) => (
                  <li key={d.domain} className="row-split">
                    <Link href={`/domain/${d.domain}`} className="mono">{d.domain}</Link>
                    <span className="small">
                      <span className="money">{d.tagViews.toLocaleString()}</span> views
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {analytics.daily.length > 0 ? (
            <section className="section-rule stack">
              <h2 className="display display-section">Tag views per day</h2>
              <ul className="holding-list">
                {analytics.daily.map((d) => (
                  <li key={d.day} className="row-split">
                    <span className="mono small">{d.day}</span>
                    <span className="money">{d.views.toLocaleString()}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      )}

      <div className="row-split">
        <Link href={`/u/${h}`} className="btn">Back to your profile</Link>
      </div>
    </div>
  );
}
