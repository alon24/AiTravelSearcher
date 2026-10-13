// Google Flights rejects IATA city codes but accepts comma-separated airports (the same groups as city_airports in src/flightagent/data/config.json).
export const CITY_AIRPORTS = {
  ROM: "FCO,CIA", LON: "LHR,LGW,STN,LTN,LCY", PAR: "CDG,ORY,BVA", NYC: "JFK,EWR,LGA",
  MIL: "MXP,LIN,BGY", BER: "BER", STO: "ARN,BMA,NYO", MOW: "SVO,DME,VKO",
  TYO: "HND,NRT", WAS: "IAD,DCA,BWI", CHI: "ORD,MDW", BUH: "OTP,BBU",
  BJS: "PEK,PKX", OSA: "KIX,ITM", SAO: "GRU,CGH,VCP", BUE: "EZE,AEP",
  MAD: "MAD", BRU: "BRU", IST: "IST,SAW", VCE: "VCE,TSF",
};

/** A metropolitan code that is not itself an airport (ROM, not IST). */
export const isCityOnly = code => !!CITY_AIRPORTS[code] && !CITY_AIRPORTS[code].split(",").includes(code);
