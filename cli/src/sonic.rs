use anyhow::{anyhow, Result};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
pub struct AgentInfo {
    pub host: String,
    pub port: u16,
    #[serde(rename = "agentKey")]
    pub agent_key: String,
}

#[derive(Debug, Deserialize)]
pub struct SonicDevice {
    #[serde(rename = "udId")]
    pub ud_id: String,
    #[serde(rename = "nickName")]
    pub nick_name: Option<String>,
    pub platform: u8,
    pub status: String,
}

#[derive(Debug, Clone)]
pub struct SonicConnection {
    pub host: String,
    pub port: u16,
    pub key: String,
    pub token: String,
}

#[derive(Debug, Deserialize)]
struct ApiResponse<T> {
    code: i32,
    message: Option<String>,
    data: Option<T>,
}

pub struct SonicClient {
    base_url: String,
    agent_id: u32,
    token: String,
}

impl SonicClient {
    pub fn new(base_url: String, agent_id: u32, token: String) -> Self {
        Self { base_url, agent_id, token }
    }

    pub fn fetch_agent_info(&self) -> Result<AgentInfo> {
        let url = format!("{}/server/api/controller/agents?id={}", self.base_url, self.agent_id);
        let resp: ApiResponse<AgentInfo> = reqwest::blocking::Client::new()
            .get(&url)
            .header("SonicToken", &self.token)
            .send()?
            .json()?;
        if resp.code != 2000 {
            return Err(anyhow!("Sonic API error: {:?}", resp.message));
        }
        resp.data.ok_or_else(|| anyhow!("Empty agent data"))
    }

    pub fn fetch_devices(&self) -> Result<Vec<SonicDevice>> {
        let url = format!(
            "{}/server/api/controller/devices/listByAgentId?agentId={}",
            self.base_url, self.agent_id
        );
        let resp: ApiResponse<Vec<SonicDevice>> = reqwest::blocking::Client::new()
            .get(&url)
            .header("SonicToken", &self.token)
            .send()?
            .json()?;
        if resp.code != 2000 {
            return Err(anyhow!("Sonic API error: {:?}", resp.message));
        }
        Ok(resp.data.unwrap_or_default())
    }

    pub fn get_connection(&self) -> Result<(SonicConnection, Vec<SonicDevice>)> {
        let agent = self.fetch_agent_info()?;
        let devices = self.fetch_devices()?;
        let conn = SonicConnection {
            host: agent.host,
            port: agent.port,
            key: agent.agent_key,
            token: self.token.clone(),
        };
        Ok((conn, devices))
    }
}

pub fn send_command_and_wait(
    conn: &SonicConnection,
    ud_id: &str,
    platform: u8,
    payload: &serde_json::Value,
    expected_msg: Option<&str>,
) -> Result<Option<serde_json::Value>> {
    use tungstenite::connect;
    use tungstenite::Message;

    let path = if platform == 2 { "ios" } else { "android" };
    let url = format!(
        "ws://{}:{}/websockets/{}/{}/{}/{}",
        conn.host, conn.port, path, conn.key, ud_id, conn.token
    );
    let (mut socket, _) = connect(&url)?;
    socket.send(Message::Text(payload.to_string().into()))?;

    if let Some(expected) = expected_msg {
        loop {
            let msg = socket.read()?;
            if let Message::Text(ref text) = msg {
                let val: serde_json::Value = serde_json::from_str(&text)?;
                if val.get("msg").and_then(|m| m.as_str()) == Some(expected) {
                    socket.close(None)?;
                    return Ok(Some(val));
                }
            }
            if let Message::Binary(_) = msg {
                break;
            }
        }
    }
    socket.close(None)?;
    Ok(None)
}
