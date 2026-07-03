import { CmcCryptoCurrency, CmcQuote } from "./cmc.types";

export interface PriceDropAlert {
  coin: CmcCryptoCurrency;
  quote: CmcQuote;
  thresholdPercent: number;
}
