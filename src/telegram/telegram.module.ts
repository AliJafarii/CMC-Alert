import { HttpModule } from "@nestjs/axios";
import { Module } from "@nestjs/common";
import { SubscriberRepositoryService } from "./subscriber-repository.service";
import { TelegramNotifierService } from "./telegram-notifier.service";
import { TelegramUpdateService } from "./telegram-update.service";

@Module({
  imports: [HttpModule],
  providers: [
    SubscriberRepositoryService,
    TelegramNotifierService,
    TelegramUpdateService,
  ],
  exports: [TelegramNotifierService],
})
export class TelegramModule {}
