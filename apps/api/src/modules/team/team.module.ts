import { Module, type DynamicModule } from "@nestjs/common";
import { TeamController } from "./team.controller";
import { TEAM_INVITATION_BASE_URL, TeamService } from "./team.service";

@Module({})
export class TeamModule {
  static forRoot(invitationBaseUrl: string): DynamicModule {
    return {
      module: TeamModule,
      controllers: [TeamController],
      providers: [TeamService, { provide: TEAM_INVITATION_BASE_URL, useValue: invitationBaseUrl }],
    };
  }
}
