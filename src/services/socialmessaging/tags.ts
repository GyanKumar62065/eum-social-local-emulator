import type { Ctx, HandlerMap } from '../../context.ts'
import { invalid } from '../../smithy/errors.ts'
import { listTags, putTags, removeTags } from '../../store/tags.ts'
import { listPhones, listWabas } from '../../store/wabas.ts'
function requireTaggable(ctx: Ctx, arn: string): void {
  const known = listWabas(ctx.db).flatMap((waba) => [waba.arn, ...listPhones(ctx.db, waba.id).map((phone) => phone.arn)])
  if (!known.includes(arn)) throw invalid(`Resource ${arn} not found`)
}
export const tagHandlers: HandlerMap = {
  TagResource(input, ctx) { requireTaggable(ctx, input.resourceArn); putTags(ctx.db, input.resourceArn, input.tags); return { statusCode: 200 } },
  UntagResource(input, ctx) { requireTaggable(ctx, input.resourceArn); removeTags(ctx.db, input.resourceArn, input.tagKeys); return { statusCode: 200 } },
  ListTagsForResource(input, ctx) { requireTaggable(ctx, input.resourceArn); return { statusCode: 200, tags: listTags(ctx.db, input.resourceArn) } },
}
