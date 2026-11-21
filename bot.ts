import { run } from "./mechfight.ts"
import { Brain } from "./brain.ts"

run((hello) => new Brain(hello))
