import { Module } from "@nestjs/common";
import { HttpModule } from "@nestjs/axios";
import { TelegramModule } from "../telegram/telegram.module";
import { AlertStateService } from "./alert-state.service";
import { CmcPollerService } from "./cmc-poller.service";
import { CmcService } from "./cmc.service";
import { CoinGeckoService } from "./coingecko.service";
import { PriceAlertService } from "./price-alert.service";

@Module({
  imports: [HttpModule, TelegramModule],
  providers: [
    AlertStateService,
    CmcService,
    CoinGeckoService,
    CmcPollerService,
    PriceAlertService,
  ],
})
export class CmcModule {}
