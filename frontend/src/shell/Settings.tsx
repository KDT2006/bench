import { usePreferences, type Theme } from "./preferences";

const themes: { value: Theme; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

export function Settings() {
  const { theme, keymap, fontSize, autosave, setTheme, setKeymap, setFontSize, setAutosave } = usePreferences();
  return (
    <div className="overlay-body settings">
      <fieldset>
        <legend>Theme</legend>
        <div className="theme-options">
          {themes.map(({ value, label }) => (
            <label className="theme-choice" key={value}>
              <input type="radio" name="theme" value={value} checked={theme === value} onChange={() => setTheme(value)} />
              <span>{label}</span>
            </label>
          ))}
        </div>
        <p className="help-text">Light uses Aluminum. Dark uses Graphite.</p>
      </fieldset>
      <div className="settings-grid">
        <label>
          Editor keymap
          <select value={keymap} onChange={(event) => setKeymap(event.target.value === "vim" ? "vim" : "default")}>
            <option value="default">Default</option>
            <option value="vim">Vim</option>
          </select>
        </label>
        <label>
          Editor font size
          <select value={fontSize} onChange={(event) => setFontSize(Number(event.target.value))}>
            {[12, 13, 14, 15, 16, 18, 20].map((size) => <option key={size} value={size}>{size} px</option>)}
          </select>
        </label>
      </div>
      <label className="check-setting">
        <input type="checkbox" checked={autosave} onChange={(event) => setAutosave(event.target.checked)} />
        Autosave
      </label>
      <p className="help-text">Editor preferences are saved on this device.</p>
    </div>
  );
}
