import { Module } from "@nestjs/common";
import { HttpModule } from "@nestjs/axios";
import { TelegramModule } from "../telegram/telegram.module";
import { AlertStateService } from "./alert-state.service";
import { CmcPollerService } from "./cmc-poller.service";
import { CmcService } from "./cmc.service";
import { CoinGeckoService } from "./coingecko.service";
import { DexMarketValidationService } from "./dex-market-validation.service";
import { PriceAnomalyService } from "./price-anomaly.service";
import { PriceAlertService } from "./price-alert.service";

@Module({
  imports: [HttpModule, TelegramModule],
  providers: [
    AlertStateService,
    CmcService,
    CoinGeckoService,
    CmcPollerService,
    DexMarketValidationService,
    PriceAnomalyService,
    PriceAlertService,
  ],
})
export class CmcModule {}
