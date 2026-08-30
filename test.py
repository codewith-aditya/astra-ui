import requests

BASE_URL = "https://0b61-34-41-171-138.ngrok-free.app/chat"

data = {
    "message": "2+2 kya hota hai?"
}

try:
    res = requests.post(BASE_URL, json=data)
    print("Status:", res.status_code)
    print("Response:", res.text)
except Exception as e:
    print("Error:", e)