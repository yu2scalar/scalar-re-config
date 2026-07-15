/*
 * Copyright 2026 Scalar Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

interface Props {
  /** Human-friendly field label. */
  label: string;
  /**
   * The corresponding RE property the field maps to — the Spring property name
   * (`scalar-re.*` / `retry.*` / `server.*`, per core UnifiedConfigLoader) for unified-config
   * fields, or the ScalarDB engine property (`scalar.db.*`) for ScalarDB settings. Shown so the
   * operator can see exactly which RE knob each form field drives (drift detection).
   */
  prop: string;
}

/**
 * A form label that also displays the corresponding RE property name beneath it.
 * Use in place of {@code <label className="form-label">…</label>} inside a {@code form-group}.
 */
export default function PropLabel({ label, prop }: Props) {
  return (
    <label className="form-label">
      {label}
      <code className="prop-name" title="Corresponding RE property">{prop}</code>
    </label>
  );
}
