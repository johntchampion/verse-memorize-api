/**
 * Admin usage report: total accounts, plus per-account activity.
 *
 * Run inside the running container:
 *   docker exec -it <container> npm run stats
 */
import { readSnapshot } from './stats/queries'
import { renderReport } from './stats/report'

function main(): void {
  console.log(renderReport(readSnapshot()))
}

main()
