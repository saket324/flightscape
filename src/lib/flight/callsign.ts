/**
 * Reconciling what people type with what aircraft transmit.
 *
 * Passengers know their flight as "AC103" -- an IATA airline code plus a
 * number. Aircraft transmit an ICAO callsign, "ACA103". ADS-B feeds are
 * indexed by the latter, so a search has to bridge the two.
 *
 * The primary bridge is adsbdb, which resolves either form. This table is the
 * offline fallback for when adsbdb has no record of a particular flight
 * number: it covers the carriers a user is most likely to type. It is a
 * convenience, not a source of truth, and it never invents route data.
 */

/** IATA -> ICAO airline designators for widely-flown carriers. */
const IATA_TO_ICAO: Readonly<Record<string, string>> = {
  AA: "AAL", AC: "ACA", AF: "AFR", AI: "AIC", AM: "AMX", AS: "ASA",
  AV: "AVA", AY: "FIN", AZ: "ITY", BA: "BAW", BR: "EVA", CI: "CAL",
  CM: "CMP", CX: "CPA", DL: "DAL", EK: "UAE", EI: "EIN", ET: "ETH",
  EY: "ETD", F9: "FFT", FR: "RYR", G4: "AAY", GA: "GIA", HA: "HAL",
  IB: "IBE", JL: "JAL", KE: "KAL", KL: "KLM", LA: "LAN", LH: "DLH",
  LO: "LOT", LX: "SWR", MH: "MAS", MS: "MSR", MU: "CES", NH: "ANA",
  NK: "NKS", NZ: "ANZ", OS: "AUA", OZ: "AAR", PR: "PAL", QF: "QFA",
  QR: "QTR", SK: "SAS", SQ: "SIA", SU: "AFL", SV: "SVA", TG: "THA",
  TK: "THY", TP: "TAP", TS: "TSC", UA: "UAL", UX: "AEA", VA: "VOZ",
  VN: "HVN", VS: "VIR", WN: "SWA", WS: "WJA", WY: "OMA", ZG: "AZA",
  "3M": "SIL", B6: "JBU", CA: "CCA", CZ: "CSN", DE: "CFG", EW: "EWG",
  FI: "ICE", HU: "CHH", JQ: "JST", LY: "ELY", NO: "NOS", PD: "POE",
  RJ: "RJA", SN: "BEL", TR: "TGW", U2: "EZY", VJ: "VJC", W6: "WZZ",
};

const ICAO_TO_IATA: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(IATA_TO_ICAO).map(([iata, icao]) => [icao, iata]),
);

/** Splits a callsign into its airline designator and flight number. */
const CALLSIGN_PATTERN = /^([A-Z0-9]{2,3}?)(\d{1,4}[A-Z]?)$/;

export type ParsedCallsign = {
  airlineCode: string;
  flightNumber: string;
};

export function parseCallsign(identifier: string): ParsedCallsign | null {
  const cleaned = identifier.trim().toUpperCase().replace(/[\s-]/g, "");

  // Try the three-letter ICAO split first: "ACA103" is unambiguous, whereas
  // splitting it as "AC" + "A103" would not match the numeric group.
  const asIcao = /^([A-Z]{3})(\d{1,4}[A-Z]?)$/.exec(cleaned);
  if (asIcao) {
    return { airlineCode: asIcao[1], flightNumber: asIcao[2] };
  }

  const match = CALLSIGN_PATTERN.exec(cleaned);
  return match ? { airlineCode: match[1], flightNumber: match[2] } : null;
}

/**
 * Every callsign form worth trying for a user's input, best guess first.
 *
 * Returning candidates rather than one answer keeps the caller honest: we do
 * not know which form an aircraft is transmitting until a feed confirms it.
 */
export function callsignCandidates(identifier: string): string[] {
  const cleaned = identifier.trim().toUpperCase().replace(/[\s-]/g, "");
  if (!cleaned) return [];

  const candidates = new Set<string>();
  const parsed = parseCallsign(cleaned);

  if (parsed) {
    const { airlineCode, flightNumber } = parsed;

    // A two-letter code is IATA; map it to ICAO, which is what gets transmitted.
    const icao = IATA_TO_ICAO[airlineCode];
    if (icao) candidates.add(`${icao}${flightNumber}`);

    // Already ICAO: use as-is, and offer the IATA form for metadata lookups.
    if (airlineCode.length === 3) {
      candidates.add(cleaned);
      const iata = ICAO_TO_IATA[airlineCode];
      if (iata) candidates.add(`${iata}${flightNumber}`);
    }

    // Some feeds zero-pad the numeric part to three digits.
    if (icao && /^\d{1,2}$/.test(flightNumber)) {
      candidates.add(`${icao}${flightNumber.padStart(3, "0")}`);
    }
  }

  candidates.add(cleaned);
  return [...candidates];
}

export function icaoForIata(iata: string): string | null {
  return IATA_TO_ICAO[iata.toUpperCase()] ?? null;
}

export function iataForIcao(icao: string): string | null {
  return ICAO_TO_IATA[icao.toUpperCase()] ?? null;
}

/**
 * The form to show a passenger.
 *
 * People recognise "AC103", not "ACA103", so we prefer the IATA rendering
 * when we can derive one.
 */
export function displayFlightNumber(callsign: string): string {
  const parsed = parseCallsign(callsign);
  if (!parsed) return callsign.trim().toUpperCase();

  const iata = ICAO_TO_IATA[parsed.airlineCode];
  return iata
    ? `${iata}${parsed.flightNumber.replace(/^0+(?=\d)/, "")}`
    : `${parsed.airlineCode}${parsed.flightNumber}`;
}
