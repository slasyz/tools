use std::{
    env, fs,
    io::{self, Write},
    path::{Path, PathBuf},
    process::Command,
};

const LABEL: &str = "local.transcribe-server";
const MARKER: &str = "<!-- Managed by transcribe-server install. -->";

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

fn home() -> Result<PathBuf> {
    let home = PathBuf::from(env::var_os("HOME").ok_or("HOME is not set")?);
    if !home.is_absolute() {
        return Err("HOME must be an absolute path".into());
    }
    Ok(home)
}

fn agent_path(home: &Path) -> PathBuf {
    home.join(format!("Library/LaunchAgents/{LABEL}.plist"))
}

fn domain() -> Result<String> {
    let output = Command::new("id").arg("-u").output()?;
    if !output.status.success() {
        return Err("could not determine current user ID".into());
    }
    let uid = String::from_utf8(output.stdout)?.trim().to_owned();
    uid.parse::<u32>()?;
    Ok(format!("gui/{uid}"))
}

fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn xml_path(path: &Path) -> Result<String> {
    Ok(xml_escape(path.to_str().ok_or("path is not valid UTF-8")?))
}

fn plist(executable: &Path, home: &Path) -> Result<String> {
    let logs = home.join("Library/Logs/transcribe-server");
    Ok(format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
         <!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n\
         {MARKER}\n\
         <plist version=\"1.0\"><dict>\n\
         <key>Label</key><string>{LABEL}</string>\n\
         <key>ProgramArguments</key><array><string>{}</string></array>\n\
         <key>EnvironmentVariables</key><dict>\n\
         <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>\n\
         <key>HOME</key><string>{}</string>\n\
         </dict>\n\
         <key>StandardOutPath</key><string>{}</string>\n\
         <key>StandardErrorPath</key><string>{}</string>\n\
         <key>RunAtLoad</key><true/>\n\
         <key>KeepAlive</key><true/>\n\
         <key>ThrottleInterval</key><integer>10</integer>\n\
         </dict></plist>\n",
        xml_path(executable)?,
        xml_path(home)?,
        xml_path(&logs.join("stdout.log"))?,
        xml_path(&logs.join("stderr.log"))?,
    ))
}

fn launchctl(args: &[&str]) -> Result<()> {
    let output = Command::new("launchctl").args(args).output()?;
    if !output.status.success() {
        return Err(format!(
            "launchctl {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr).trim()
        )
        .into());
    }
    Ok(())
}

fn loaded(service: &str) -> Result<bool> {
    Ok(Command::new("launchctl")
        .args(["print", service])
        .output()?
        .status
        .success())
}

fn existing(path: &Path) -> Result<Option<String>> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if !metadata.file_type().is_file() {
                return Err(format!("not a regular file: {}", path.display()).into());
            }
            Ok(Some(fs::read_to_string(path)?))
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn managed_agent_path() -> Result<PathBuf> {
    let path = agent_path(&home()?);
    let content = existing(&path)?.ok_or_else(|| {
        format!(
            "no LaunchAgent at {}; run transcribe-server install first",
            path.display()
        )
    })?;
    if !content.contains(MARKER) || !content.contains(&format!("<string>{LABEL}</string>")) {
        return Err(format!("{} is not a transcribe-server LaunchAgent", path.display()).into());
    }
    Ok(path)
}

fn service() -> Result<String> {
    Ok(format!("{}/{LABEL}", domain()?))
}

fn bootstrap(path: &Path, domain: &str) -> Result<()> {
    launchctl(&[
        "bootstrap",
        domain,
        path.to_str().ok_or("path is not valid UTF-8")?,
    ])
}

pub fn start() -> Result<()> {
    let path = managed_agent_path()?;
    let domain = domain()?;
    let service = format!("{domain}/{LABEL}");
    if loaded(&service)? {
        launchctl(&["kickstart", &service])?;
    } else {
        fs::create_dir_all(home()?.join("Library/Logs/transcribe-server"))?;
        bootstrap(&path, &domain)?;
    }
    println!("Started {service}");
    Ok(())
}

pub fn stop() -> Result<()> {
    managed_agent_path()?;
    let service = service()?;
    if loaded(&service)? {
        launchctl(&["bootout", &service])?;
        println!("Stopped {service}");
    } else {
        println!("{service} is already stopped");
    }
    Ok(())
}

pub fn restart() -> Result<()> {
    let path = managed_agent_path()?;
    let domain = domain()?;
    let service = format!("{domain}/{LABEL}");
    if loaded(&service)? {
        launchctl(&["kickstart", "-k", &service])?;
    } else {
        fs::create_dir_all(home()?.join("Library/Logs/transcribe-server"))?;
        bootstrap(&path, &domain)?;
    }
    println!("Restarted {service}");
    Ok(())
}

pub fn install() -> Result<()> {
    let home = home()?;
    let executable = env::current_exe()?;
    let path = agent_path(&home);
    let content = plist(&executable, &home)?;
    let domain = domain()?;
    let service = format!("{domain}/{LABEL}");
    let was_present = match existing(&path)? {
        Some(old) if old == content => true,
        Some(_) => {
            return Err(format!(
                "{} already exists with different contents; refusing to overwrite it (uninstall first if it is ours)",
                path.display()
            )
            .into());
        }
        None => false,
    };
    if loaded(&service)? {
        if was_present {
            println!("LaunchAgent already installed and running: {service}");
            return Ok(());
        }
        return Err(format!("{service} is already loaded; refusing to replace it").into());
    }
    fs::create_dir_all(home.join("Library/LaunchAgents"))?;
    fs::create_dir_all(home.join("Library/Logs/transcribe-server"))?;
    if !was_present {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)?;
        file.write_all(content.as_bytes())?;
    }
    // Leave the plist in place on failure so the user can inspect or retry it.
    bootstrap(&path, &domain)?;
    println!("Installed and started {service} ({})", path.display());
    Ok(())
}

pub fn uninstall() -> Result<()> {
    let path = agent_path(&home()?);
    if existing(&path)?.is_none() {
        println!("No LaunchAgent at {}", path.display());
        return Ok(());
    }
    managed_agent_path()?;
    let service = service()?;
    if loaded(&service)? {
        launchctl(&["bootout", &service])?;
    }
    fs::remove_file(&path)?;
    println!("Stopped and removed {service}");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{LABEL, plist};
    use std::path::Path;

    #[test]
    fn plist_escapes_paths_and_sets_login_restart() {
        let xml = plist(Path::new("/tmp/a&<b>"), Path::new("/Users/test's home")).unwrap();
        assert!(xml.contains("/tmp/a&amp;&lt;b&gt;"));
        assert!(xml.contains("/Users/test&apos;s home"));
        assert!(xml.contains(&format!("<string>{LABEL}</string>")));
        assert!(xml.contains("<key>RunAtLoad</key><true/>"));
        assert!(xml.contains("<key>KeepAlive</key><true/>"));
    }
}
