import type { AssetPickerOptions } from "../../media/index.ts";
import type { OptionalSchema } from "../../schema/types.ts";
import { AssetControl } from "../app/pickers.tsx";
import { defineReactWidget } from "../react.tsx";

/** The default widget for `image()`, `video()` and `file()`. */
export default defineReactWidget<any, AssetPickerOptions>(({ value, onChange, options, field }) => (
  <AssetControl
    schema={field.schema.type === "optional" ? (field.schema as OptionalSchema).inner : field.schema}
    value={value}
    onChange={onChange}
    path={field.path}
    issues={field.issues}
    readOnly={field.readOnly}
    optional={!field.required}
    doc={field.document}
    field={field}
    options={options}
  />
));
