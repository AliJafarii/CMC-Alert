import { Module } from "@nestjs/common";
import { HttpModule } from "@nestjs/axios";
import { TelegramModule } from "../telegram/telegram.module";
import { AlertStateService } from "./alert-state.service";
import { CmcPollerService } from "./cmc-poller.service";
import { CmcService } from "./cmc.service";
import { CoinGeckoService } from "./coingecko.service";
import { PriceAnomalyService } from "./price-anomaly.service";
import { PriceAlertService } from "./price-alert.service";
import { TradeExecutionService } from "./trade-execution.service";
import { TradeSettingsService } from "./trade-settings.service";
import { TradeValidationService } from "./trade-validation.service";

@Module({
  imports: [HttpModule, TelegramModule],
  providers: [
    AlertStateService,
    CmcService,
    CoinGeckoService,
    CmcPollerService,
    PriceAnomalyService,
    PriceAlertService,
    TradeExecutionService,
    TradeSettingsService,
    TradeValidationService,
  ],
})
export class CmcModule {}
