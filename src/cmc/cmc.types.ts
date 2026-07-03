export interface CmcListingResponse {
  data?: {
    cryptoCurrencyList?: CmcCryptoCurrency[];
    totalCount?: string | number;
  };
  status?: {
    error_code?: string | number;
    error_message?: string;
  };
}

export interface CmcCryptoCurrency {
  id: number | string;
  name: string;
  symbol: string;
  slug: string;
  cmcRank?: number;
  lastUpdated?: string;
  source?: "CoinMarketCap" | "CoinGecko";
  sourceUrl?: string;
  sourceRankLabel?: string;
  quotes?: CmcQuote[];
}

export interface CmcQuote {
  name: string;
  price: number;
  volume24h?: number;
  percentChange1h?: number;
  percentChange24h?: number;
  percentChange7d?: number;
  marketCap?: number;
  lastUpdated?: string;
}

export interface CoinGeckoMarketCoin {
  id: string;
  symbol: string;
  name: string;
  current_price: number | null;
  market_cap_rank: number | null;
  total_volume?: number | null;
  price_change_percentage_1h_in_currency?: number | null;
  price_change_percentage_24h?: number | null;
  market_cap?: number | null;
  last_updated?: string;
}
