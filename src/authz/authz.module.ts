import { Global, Module, Provider } from '@nestjs/common';

import { getSequelize } from '../db/sequelize';
import { TenancyService } from '../db/tenancy';
import { AuthzService } from './authz.service';
import { CrawlRepository } from './content/crawl.repository';
import { GraphRepository } from './content/graph.repository';
import { PageRepository } from './content/pages.repository';
import { ContentReports } from './content/reports';
import { SearchRepository } from './content/search.repository';

const CONTENT = [
  PageRepository,
  GraphRepository,
  SearchRepository,
  CrawlRepository,
  ContentReports,
];

@Global()
@Module({
  providers: [
    AuthzService,
    TenancyService,
    ...CONTENT.map(
      (cls): Provider => ({ provide: cls, useFactory: () => new cls(getSequelize()) }),
    ),
  ],
  exports: [AuthzService, TenancyService, ...CONTENT],
})
export class AuthzModule {}
