import browser from "webextension-polyfill";

const cleverCloudOwnedDomains = [
  /[.]clevercloudstatus[.]com$/,
  /[.]clever-cloud[.]com$/,
  /[.]cleverapps[.]io$/,
  /[.]clevergrid[.]io$/,
];
const cleverCloudFrontalDomains =
  /^domain[.]([A-Za-z0-9-]+)[.]clever-cloud[.]com$/;

interface Result {
  isHostedByCleverCloud: boolean;
  zone: string | null;
}

async function check(hostname: string): Promise<Result> {
  console.log(`Checking if '${hostname}' is hosted by Clever Cloud...`);

  // Check if hostname is an owned Clever Cloud domain
  if (cleverCloudOwnedDomains.some((r) => r.test(hostname))) {
    return { isHostedByCleverCloud: true, zone: null };
  } else {
    const answer = await browser.dns.resolve(hostname, ["canonical_name"]);
    const domainMatch = cleverCloudFrontalDomains.exec(
      answer.canonicalName ?? ""
    );

    // Check if cannonical hostname is a frontal Clever Cloud domain
    if (domainMatch !== null) {
      return { isHostedByCleverCloud: true, zone: domainMatch[1] };
    } else {
      let zone;
      for (const ip of answer.addresses) {
        const z = await getZoneFromIp(ip);
        if (z !== null) {
          zone = z;
          break;
        }
      }

      // Check if any resolved IP is linked to a Clever Cloud frontal domain
      if (zone !== undefined) {
        return { isHostedByCleverCloud: true, zone };
      } else {
        // Check if cannonical hostname is an owned Clever Cloud domain
        if (cleverCloudOwnedDomains.some((r) => r.test(hostname))) {
          return { isHostedByCleverCloud: true, zone: null };
        } else {
          return { isHostedByCleverCloud: false, zone: null };
        }
      }
    }
  }
}

async function getZones(): Promise<string[]> {
  interface Zone {
    name: string;
  }

  const res = await fetch("https://api.clever-cloud.com/v2/products/zones");
  const body = (await res.json()) as Zone[];

  return body.map((z) => z.name);
}

async function getZoneIps(zone: string): Promise<string[]> {
  const hostname = `domain.${zone}.clever-cloud.com`;
  const answer = await browser.dns.resolve(hostname);

  return answer.addresses;
}

async function cacheIpsWithZones(): Promise<void> {
  const zones = await getZones();
  const ps = zones.map((zone) =>
    getZoneIps(zone).then((ips) => ({ zone, ips }))
  );
  const zonesWithIps = await Promise.allSettled(ps);
  const ipsWithZones = zonesWithIps.flatMap((res) => {
    if (res.status === "fulfilled") {
      const { zone, ips } = res.value;
      return ips.map((ip) => ({ zone, ip }));
    } else {
      return [];
    }
  });
  const ipsWithZonesObject = ipsWithZones.reduce(
    (acc, { zone, ip }) => ({ [`ip-${ip}`]: zone, ...acc }),
    {}
  );

  console.log(`Found ${ipsWithZones.length} IPs in ${zones.length} zones`);
  await browser.storage.session.set({
    zonesLastSync: Date.now().toString(),
    ...ipsWithZonesObject,
  });
}

async function getZoneFromIp(ip: string): Promise<string | null> {
  const lastSync = (await browser.storage.session.get("zonesLastSync"))
    .zonesLastSync as string | undefined;
  const key = `ip-${ip}`;
  if (lastSync !== undefined) {
    return (await browser.storage.session.get(key))[key] as string;
  } else {
    console.log("Caching Clever Cloud frontal IPs...");
    await cacheIpsWithZones();
    return (await browser.storage.session.get(key))[key] as string;
  }
}

browser.webNavigation.onCommitted.addListener((e) => {
  const hostname = new URL(e.url).hostname;

  if (hostname.length > 0) {
    check(hostname).then(async (result) => {
      if (result.isHostedByCleverCloud) {
        await browser.pageAction.setIcon({
          tabId: e.tabId,
          path: "/up_/assets/yes.svg",
        });

        if (result.zone !== null) {
          browser.pageAction.setTitle({
            tabId: e.tabId,
            title: browser.i18n.getMessage("pageActionTitleIfYesWithZone", [
              result.zone,
            ]),
          });
        } else {
          browser.pageAction.setTitle({
            tabId: e.tabId,
            title: browser.i18n.getMessage("pageActionTitleIfYesBecauseOwned"),
          });
        }
      } else {
        await browser.pageAction.setIcon({
          tabId: e.tabId,
          path: "/up_/assets/no.svg",
        });
        browser.pageAction.setTitle({
          tabId: e.tabId,
          title: browser.i18n.getMessage("pageActionTitleIfNo"),
        });
      }

      await browser.pageAction.show(e.tabId);
    }, console.error);
  }
});
