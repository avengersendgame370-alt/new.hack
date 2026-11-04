#!/usr/bin/env python3
"""Weather CLI App - fetch current weather for a city using OpenWeatherMap."""

import argparse
import os
import sys
import requests

API_URL = "https://api.openweathermap.org/data/2.5/weather"

UNIT_SYMBOLS = {"metric": "°C", "imperial": "°F", "standard": "K"}


def get_weather(city: str, api_key: str, units: str = "metric") -> dict:
    """Call the API and return the parsed JSON. Raises on failure."""
    params = {"q": city, "appid": api_key, "units": units}
    response = requests.get(API_URL, params=params, timeout=10)

    if response.status_code == 401:
        raise ValueError("Invalid API key. New keys can take a couple of hours to activate.")
    if response.status_code == 404:
        raise ValueError(f"City '{city}' not found. Check the spelling and try again.")
    response.raise_for_status()
    return response.json()


def display_weather(data: dict, units: str = "metric") -> None:
    """Print a readable summary of the weather data."""
    symbol = UNIT_SYMBOLS[units]
    city = data["name"]
    country = data["sys"]["country"]
    temp = data["main"]["temp"]
    feels_like = data["main"]["feels_like"]
    humidity = data["main"]["humidity"]
    description = data["weather"][0]["description"].capitalize()

    print(f"\nWeather in {city}, {country}")
    print("-" * 30)
    print(f"Temperature : {temp:.1f}{symbol} (feels like {feels_like:.1f}{symbol})")
    print(f"Condition   : {description}")
    print(f"Humidity    : {humidity}%\n")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Show current weather for a city.")
    parser.add_argument("city", nargs="+", help="City name, e.g. Kolkata or 'New York'")
    parser.add_argument(
        "-u", "--units",
        choices=["metric", "imperial", "standard"],
        default="metric",
        help="Units of measurement (default: metric)",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    city = " ".join(args.city)

    api_key = os.environ.get("OPENWEATHER_API_KEY")
    if not api_key:
        sys.exit("Error: set the OPENWEATHER_API_KEY environment variable first.")

    try:
        data = get_weather(city, api_key, args.units)
        display_weather(data, args.units)
    except ValueError as err:
        sys.exit(f"Error: {err}")
    except requests.exceptions.ConnectionError:
        sys.exit("Error: could not connect. Check your internet connection.")
    except requests.exceptions.Timeout:
        sys.exit("Error: the request timed out. Try again.")
    except requests.exceptions.RequestException as err:
        sys.exit(f"Error: request failed ({err}).")


if __name__ == "__main__":
    main()
