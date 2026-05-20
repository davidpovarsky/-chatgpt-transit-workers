import { createMcpHandler } from "agents/mcp";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

interface Env {
  ASSETS: Fetcher;
}

const MCP_PATH = "/mcp";
const TRANSIT_WIDGET_URI = "ui://widget/transit.html";

type GeocodeCandidate = {
  lat: number;
  lng: number;
  formatted_address: string;
};

type ReverseGeocodeResult = {
  lat: number;
  lon: number;
  display_name: string;
  road?: string;
  suburb?: string;
  city?: string;
  country?: string;
  formatted_for_directions: string;
};

type TransitStepSummary = {
  mode: string;
  route?: string;
  agency?: string;
  from: string;
  to: string;
  startTime: string;
  endTime: string;
  durationMinutes: number;
  distanceMeters?: number;
  realtime?: boolean;
  stopCodeFrom?: string;
  stopCodeTo?: string;
};

type TransitItinerarySummary = {
  index: number;
  durationMinutes: number;
  startTime: string;
  endTime: string;
  walkDistanceMeters: number;
  walkTimeMinutes: number;
  transitTimeMinutes: number;
  waitingTimeMinutes: number;
  transfers: number;
  fareText: string;
  routes: string[];
  steps: TransitStepSummary[];
  alerts: string[];
};

type UserLocationHint = {
  latitude?: number;
  longitude?: number;
  city?: string;
  region?: string;
  country?: string;
  timezone?: string;
};

const transitOutputSchema = {
  usedLocationSource: z.string(),
  from: z.object({
    name: z.string(),
    lat: z.number(),
    lon: z.number(),
    display_name: z.string(),
  }),
  to: z.object({
    name: z.string(),
    lat: z.number(),
    lon: z.number(),
  }),
  summary: z.string(),
  itineraries: z.array(
    z.object({
      index: z.number(),
      durationMinutes: z.number(),
      startTime: z.string(),
      endTime: z.string(),
      walkDistanceMeters: z.number(),
      walkTimeMinutes: z.number(),
      transitTimeMinutes: z.number(),
      waitingTimeMinutes: z.number(),
      transfers: z.number(),
      fareText: z.string(),
      routes: z.array(z.string()),
      steps: z.array(
        z.object({
          mode: z.string(),
          route: z.string().optional(),
          agency: z.string().optional(),
          from: z.string(),
          to: z.string(),
          startTime: z.string(),
          endTime: z.string(),
          durationMinutes: z.number(),
          distanceMeters: z.number().optional(),
          realtime: z.boolean().optional(),
          stopCodeFrom: z.string().optional(),
          stopCodeTo: z.string().optional(),
        })
      ),
      alerts: z.array(z.string()),
    })
  ),
};

function minutes(secondsOrMs: number, unit: "seconds" | "ms" = "seconds") {
  const seconds = unit === "ms" ? secondsOrMs / 1000 : secondsOrMs;
  return Math.round(seconds / 60);
}

function formatTime(ms: number, locale = "he-IL") {
  return new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Jerusalem",
  }).format(new Date(ms));
}

function formatPlaceForDirections(name: string, lat: number, lon: number) {
  return `${name}::${lat},${lon}`;
}

function getFareText(itinerary: any) {
  const regular = itinerary?.fare?.fare?.regular;
  const cents = regular?.cents;
  const symbol = regular?.currency?.symbol ?? "₪";

  if (typeof cents !== "number") {
    return "לא ידוע";
  }

  return `${symbol}${(cents / 100).toFixed(2)}`;
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function getOriginCoordinates(
  args: {
    fromLat?: number;
    fromLon?: number;
  },
  meta?: Record<string, any>
) {
  if (typeof args.fromLat === "number" && typeof args.fromLon === "number") {
    return {
      lat: args.fromLat,
      lon: args.fromLon,
      source: "explicit_arguments",
    };
  }

  const location = meta?.["openai/userLocation"] as UserLocationHint | undefined;

  if (
    location &&
    typeof location.latitude === "number" &&
    typeof location.longitude === "number"
  ) {
    return {
      lat: location.latitude,
      lon: location.longitude,
      source: "openai_userLocation_meta",
    };
  }

  throw new Error(
    "חסר מיקום מוצא. צריך לשלוח fromLat/fromLon, להזין fromQuery, או להפעיל הרשאת מיקום כך ש-ChatGPT יספק openai/userLocation."
  );
}

function summarizeDirections(data: any, locale = "he-IL"): TransitItinerarySummary[] {
  const itineraries = data?.plan?.itineraries;

  if (!Array.isArray(itineraries)) {
    throw new Error("Directions API returned an unexpected response: missing plan.itineraries");
  }

  return itineraries.map((itinerary: any, index: number) => {
    const legs = Array.isArray(itinerary.legs) ? itinerary.legs : [];

    const steps: TransitStepSummary[] = legs.map((leg: any) => {
      const mode = typeof leg.mode === "string" ? leg.mode : "UNKNOWN";
      const route = typeof leg.routeShortName === "string" ? leg.routeShortName : undefined;
      const agency = typeof leg.agencyName === "string" ? leg.agencyName : undefined;

      const from = typeof leg.from?.name === "string" ? leg.from.name : "מוצא";
      const to = typeof leg.to?.name === "string" ? leg.to.name : "יעד";

      const startTime = typeof leg.startTime === "number" ? formatTime(leg.startTime, locale) : "";
      const endTime = typeof leg.endTime === "number" ? formatTime(leg.endTime, locale) : "";

      const durationMinutes =
        typeof leg.duration === "number"
          ? minutes(leg.duration, "seconds")
          : typeof leg.startTime === "number" && typeof leg.endTime === "number"
            ? minutes(leg.endTime - leg.startTime, "ms")
            : 0;

      return {
        mode,
        route,
        agency,
        from,
        to,
        startTime,
        endTime,
        durationMinutes,
        distanceMeters: typeof leg.distance === "number" ? Math.round(leg.distance) : undefined,
        realtime: typeof leg.realTime === "boolean" ? leg.realTime : undefined,
        stopCodeFrom: typeof leg.from?.stopCode === "string" ? leg.from.stopCode : undefined,
        stopCodeTo: typeof leg.to?.stopCode === "string" ? leg.to.stopCode : undefined,
      };
    });

    const routes = uniqueStrings(
      steps.filter((step) => step.mode !== "WALK").map((step) => step.route ?? "")
    );

    const legAlerts = legs.flatMap((leg: any) =>
      Array.isArray(leg.alerts)
        ? leg.alerts.map((alert: any) => alert?.alertHeaderText).filter(Boolean)
        : []
    );

    const planAlerts = Array.isArray(data?.plan?.areaAlerts)
      ? data.plan.areaAlerts.map((alert: any) => alert?.alertHeaderText).filter(Boolean)
      : [];

    return {
      index: index + 1,
      durationMinutes: typeof itinerary.duration === "number" ? minutes(itinerary.duration) : 0,
      startTime: typeof itinerary.startTime === "number" ? formatTime(itinerary.startTime, locale) : "",
      endTime: typeof itinerary.endTime === "number" ? formatTime(itinerary.endTime, locale) : "",
      walkDistanceMeters:
        typeof itinerary.walkDistance === "number" ? Math.round(itinerary.walkDistance) : 0,
      walkTimeMinutes: typeof itinerary.walkTime === "number" ? minutes(itinerary.walkTime) : 0,
      transitTimeMinutes:
        typeof itinerary.transitTime === "number" ? minutes(itinerary.transitTime) : 0,
      waitingTimeMinutes:
        typeof itinerary.waitingTime === "number" ? minutes(itinerary.waitingTime) : 0,
      transfers: typeof itinerary.transfers === "number" ? itinerary.transfers : 0,
      fareText: getFareText(itinerary),
      routes,
      steps,
      alerts: uniqueStrings([...legAlerts, ...planAlerts]).slice(0, 5),
    };
  });
}

function buildHumanSummary(fromName: string, toName: string, itineraries: TransitItinerarySummary[]) {
  if (itineraries.length === 0) {
    return `לא נמצאו מסלולים מ-${fromName} אל ${toName}.`;
  }

  const first = itineraries[0];
  const routeText = first.routes.length > 0 ? first.routes.join(" → ") : "ללא קווי תחבורה";

  return [
    `נמצא מסלול מ-${fromName} אל ${toName}.`,
    `המסלול המהיר ביותר: ${first.durationMinutes} דק׳, ${first.startTime}–${first.endTime}.`,
    `קווים: ${routeText}.`,
    `הליכה: ${first.walkDistanceMeters} מטר, מחיר: ${first.fareText}.`,
  ].join(" ");
}

async function geocodeAddress(query: string, locale = "he") {
  const url = new URL("https://api.busnearby.co.il/geocode");
  url.searchParams.set("locale", locale);
  url.searchParams.set("query", query);

  const response = await fetch(url, {
    method: "GET",
    headers: {
      accept: "application/json",
      "accept-language": locale,
      origin: "https://busnear.by",
      referer: "https://busnear.by/",
      "user-agent": "chatgpt-transit-app/0.1.0",
    },
  });

  if (!response.ok) {
    throw new Error(`Geocode API failed: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as unknown;

  if (!Array.isArray(data)) {
    throw new Error("Geocode API returned an unexpected response");
  }

  const candidates = data
    .map((item) => {
      const raw = item as any;

      const latRaw = raw?.lat;
      const lngRaw = raw?.lng ?? raw?.lon;

      const lat =
        typeof latRaw === "number"
          ? latRaw
          : typeof latRaw === "string"
            ? Number(latRaw)
            : NaN;

      const lng =
        typeof lngRaw === "number"
          ? lngRaw
          : typeof lngRaw === "string"
            ? Number(lngRaw)
            : NaN;

      const formattedAddress =
        typeof raw?.formatted_address === "string" && raw.formatted_address.trim().length > 0
          ? raw.formatted_address.trim()
          : typeof raw?.display_name === "string" && raw.display_name.trim().length > 0
            ? raw.display_name.trim()
            : typeof raw?.name === "string" && raw.name.trim().length > 0
              ? raw.name.trim()
              : query;

      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        return null;
      }

      return {
        lat,
        lng,
        formatted_address: formattedAddress,
      };
    })
    .filter((candidate): candidate is GeocodeCandidate => candidate !== null);

  if (candidates.length === 0) {
    throw new Error(`לא נמצאו קואורדינטות תקינות עבור: ${query}`);
  }

  return candidates;
}

async function reverseGeocodeLocation(
  lat: number,
  lon: number,
  locale = "he"
): Promise<ReverseGeocodeResult> {
  const url = new URL("https://nominatim.openstreetmap.org/reverse");
  url.searchParams.set("format", "json");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("extratags", "1");
  url.searchParams.set("namedetails", "1");
  url.searchParams.set("lat", String(lat));
  url.searchParams.set("lon", String(lon));

  const response = await fetch(url, {
    method: "GET",
    headers: {
      accept: "application/json",
      "accept-language": locale,
      "user-agent": "chatgpt-transit-app/0.1.0",
    },
  });

  if (!response.ok) {
    throw new Error(`Reverse geocode API failed: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as any;

  if (!data || typeof data !== "object") {
    throw new Error("Reverse geocode API returned an unexpected response");
  }

  const displayName =
    typeof data.display_name === "string" && data.display_name.length > 0
      ? data.display_name
      : `${lat}, ${lon}`;

  const address = data.address && typeof data.address === "object" ? data.address : {};

  const road = typeof address.road === "string" ? address.road : undefined;
  const suburb = typeof address.suburb === "string" ? address.suburb : undefined;
  const city = typeof address.city === "string" ? address.city : undefined;
  const country = typeof address.country === "string" ? address.country : undefined;

  const formattedParts = [road, city].filter(Boolean);
  const formattedForDirections =
    formattedParts.length > 0 ? formattedParts.join(", ") : displayName;

  return {
    lat: typeof data.lat === "string" ? Number(data.lat) : lat,
    lon: typeof data.lon === "string" ? Number(data.lon) : lon,
    display_name: displayName,
    road,
    suburb,
    city,
    country,
    formatted_for_directions: formattedForDirections,
  };
}

async function getDirections(params: {
  fromName: string;
  fromLat: number;
  fromLon: number;
  toName: string;
  toLat: number;
  toLon: number;
  locale?: string;
  numItineraries?: number;
  maxWalkDistance?: number;
}) {
  const locale = params.locale ?? "he";

  const url = new URL("https://api.busnearby.co.il/directions");

  url.searchParams.set(
    "fromPlace",
    formatPlaceForDirections(params.fromName, params.fromLat, params.fromLon)
  );
  url.searchParams.set(
    "toPlace",
    formatPlaceForDirections(params.toName, params.toLat, params.toLon)
  );
  url.searchParams.set("arriveBy", "false");
  url.searchParams.set("locale", locale);
  url.searchParams.set("wheelchair", "false");
  url.searchParams.set("mode", "WALK,TRANSIT");
  url.searchParams.set("showIntermediateStops", "true");
  url.searchParams.set("numItineraries", String(params.numItineraries ?? 6));
  url.searchParams.set("maxWalkDistance", String(params.maxWalkDistance ?? 1207));
  url.searchParams.set("optimize", "QUICK");
  url.searchParams.set("ignoreRealtimeUpdates", "false");

  const response = await fetch(url, {
    method: "GET",
    headers: {
      accept: "application/json",
      "accept-language": locale,
      origin: "https://busnear.by",
      referer: "https://busnear.by/",
      "user-agent": "chatgpt-transit-app/0.1.0",
      "x-bnb-variant": "busnear.by",
    },
  });

  if (!response.ok) {
    throw new Error(`Directions API failed: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

async function resolveTransitDirections(
  args: {
    fromQuery?: string;
    fromLat?: number;
    fromLon?: number;
    toQuery: string;
    locale?: string;
    numItineraries?: number;
    maxWalkDistance?: number;
  },
  meta?: Record<string, any>
) {
  const locale = args.locale ?? "he";

  let usedLocationSource = "";
  let from: ReverseGeocodeResult;

  if (typeof args.fromQuery === "string" && args.fromQuery.trim().length > 0) {
    const fromCandidates = await geocodeAddress(args.fromQuery.trim(), locale);

    if (fromCandidates.length === 0) {
      throw new Error(`לא נמצאה כתובת מוצא עבור: ${args.fromQuery}`);
    }

    const fromCandidate = fromCandidates[0];

    from = {
      lat: fromCandidate.lat,
      lon: fromCandidate.lng,
      display_name: fromCandidate.formatted_address,
      formatted_for_directions: fromCandidate.formatted_address,
    };

    usedLocationSource = "from_query";
  } else {
    const origin = getOriginCoordinates(args, meta);
    from = await reverseGeocodeLocation(origin.lat, origin.lon, locale);
    usedLocationSource = origin.source;
  }

  const toCandidates = await geocodeAddress(args.toQuery, locale);

  if (toCandidates.length === 0) {
    throw new Error(`לא נמצאה כתובת יעד עבור: ${args.toQuery}`);
  }

  const to = toCandidates[0];

  const rawDirections = await getDirections({
    fromName: from.formatted_for_directions,
    fromLat: from.lat,
    fromLon: from.lon,
    toName: to.formatted_address,
    toLat: to.lat,
    toLon: to.lng,
    locale,
    numItineraries: args.numItineraries ?? 3,
    maxWalkDistance: args.maxWalkDistance ?? 1207,
  });

  const allItineraries = summarizeDirections(rawDirections, "he-IL");
  const itineraries = allItineraries.slice(0, args.numItineraries ?? 3);

  const summary = buildHumanSummary(
    from.formatted_for_directions,
    to.formatted_address,
    itineraries
  );

  return {
    usedLocationSource,
    from: {
      name: from.formatted_for_directions,
      lat: from.lat,
      lon: from.lon,
      display_name: from.display_name,
    },
    to: {
      name: to.formatted_address,
      lat: to.lat,
      lon: to.lng,
    },
    summary,
    itineraries,
  };
}

async function loadTransitWidgetHtml(env: Env) {
  const response = await env.ASSETS.fetch(new Request("https://assets.local/transit-widget.html"));

  if (!response.ok) {
    throw new Error(`Failed to load transit widget HTML: ${response.status} ${response.statusText}`);
  }

  return response.text();
}

async function createTransitServer(env: Env) {
  const transitHtml = await loadTransitWidgetHtml(env);

  const server = new McpServer({
    name: "jerusalem-transit-app",
    version: "0.1.0",
  });

  registerAppResource(
    server,
    "transit-widget",
    TRANSIT_WIDGET_URI,
    {},
    async () => ({
      contents: [
        {
          uri: TRANSIT_WIDGET_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: transitHtml,
          _meta: {
            ui: {
              prefersBorder: true,
              csp: {
                connectDomains: [],
                resourceDomains: [],
              },
            },
            "openai/widgetDescription":
              "מציג מסלולי תחבורה ציבורית עם שדות לשינוי מוצא ויעד בתוך ChatGPT.",
            "openai/widgetPrefersBorder": true,
            "openai/widgetCSP": {
              connect_domains: [],
              resource_domains: [],
            },
          },
        },
      ],
    })
  );

  server.tool(
    "ping_transit",
    "Checks that the transit MCP server is running.",
    {
      message: z.string().optional(),
    },
    async ({ message }) => {
      const resolvedMessage = message ?? "שלום";

      return {
        content: [
          {
            type: "text",
            text: `Transit MCP server is working. Message: ${resolvedMessage}`,
          },
        ],
        structuredContent: {
          ok: true,
          reply: `קיבלתי: ${resolvedMessage}`,
        },
      };
    }
  );

  server.tool(
    "geocode_address",
    "Converts a Hebrew address or place name into latitude and longitude candidates.",
    {
      query: z.string().min(1).describe("Address or place name, for example: אמציה 3 ירושלים"),
      locale: z.string().default("he").optional(),
    },
    async ({ query, locale }) => {
      const resolvedLocale = locale ?? "he";
      const candidates = await geocodeAddress(query, resolvedLocale);

      return {
        content: [
          {
            type: "text",
            text:
              candidates.length === 0
                ? `לא נמצאו תוצאות עבור: ${query}`
                : `נמצאו ${candidates.length} תוצאות עבור: ${query}`,
          },
        ],
        structuredContent: {
          query,
          candidates,
        },
      };
    }
  );

  server.tool(
    "reverse_geocode_location",
    "Converts latitude and longitude into a readable Hebrew address.",
    {
      lat: z.number().describe("Latitude, for example 31.816701371119475"),
      lon: z.number().describe("Longitude, for example 35.20200743050329"),
      locale: z.string().default("he").optional(),
    },
    async ({ lat, lon, locale }) => {
      const resolvedLocale = locale ?? "he";
      const result = await reverseGeocodeLocation(lat, lon, resolvedLocale);

      return {
        content: [
          {
            type: "text",
            text: `המיקום זוהה כ: ${result.formatted_for_directions}`,
          },
        ],
        structuredContent: result,
      };
    }
  );

  registerAppTool(
    server,
    "get_transit_directions",
    {
      title: "Get transit directions",
      description:
        "Finds public transit directions. Origin can be fromQuery, explicit fromLat/fromLon, or the ChatGPT-provided user location hint.",
      inputSchema: {
        fromQuery: z
          .string()
          .optional()
          .describe("Optional origin address. If provided, it overrides fromLat/fromLon and user location."),
        fromLat: z
          .number()
          .optional()
          .describe("Optional origin latitude. If missing, the tool tries openai/userLocation."),
        fromLon: z
          .number()
          .optional()
          .describe("Optional origin longitude. If missing, the tool tries openai/userLocation."),
        toQuery: z.string().min(1).describe("Destination address, for example: אמציה 3 ירושלים"),
        locale: z.string().default("he").optional(),
        numItineraries: z.number().int().min(1).max(6).default(3).optional(),
        maxWalkDistance: z.number().int().min(100).max(5000).default(1207).optional(),
      },
      outputSchema: transitOutputSchema,
      annotations: {
        readOnlyHint: true,
      },
      _meta: {
        ui: {
          resourceUri: TRANSIT_WIDGET_URI,
          visibility: ["model", "app"],
        },
        "openai/outputTemplate": TRANSIT_WIDGET_URI,
        "openai/widgetAccessible": true,
        "openai/toolInvocation/invoking": "מחפש מסלולים…",
        "openai/toolInvocation/invoked": "המסלולים מוכנים",
      },
    },
    async (args, { _meta }) => {
      const structuredContent = await resolveTransitDirections(args, _meta);

      return {
        content: [
          {
            type: "text",
            text: structuredContent.summary,
          },
        ],
        structuredContent,
      };
    }
  );

  return server;
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return new Response("Transit MCP server is running", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    if (url.pathname === "/health") {
      return new Response("ok", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    if (url.pathname === MCP_PATH) {
      const server = await createTransitServer(env);
      return createMcpHandler(server)(request, env, ctx);
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
